/**
 * Scheduler — singleton DO ("scheduler") driving:
 *  - cron job firing (tick every 15s via alarm + per-minute Workers cron trigger)
 *  - queued task retries with backoff
 *  - DAG workflow advancement (state machine)
 *  - webhook workflow nodes (executed inline)
 *  - metrics retention pruning
 */

import type { WorkflowGraph, WorkflowStepData } from '@omni/shared';
import type { Env } from '../env';
import {
  createTask,
  finishTask,
  getCronJob,
  getRun,
  getTask,
  listCronJobs,
  listRunSteps,
  nodesMatchingTarget,
  pruneMetrics,
  pruneAlerts,
  pruneAudit,
  pruneWorkflowRuns,
  setStepStatus,
  updateCronNextRun,
  findStepsByTask,
  audit,
  encryptEnv,
} from '../db';
import { id as newId } from '../util';
import { dispatchTask } from '../dispatch';
import { advance, validateGraph, type StepState, type ValidatedGraph } from '../dag';
import { nextRun } from '../cron';
import { pushEvent } from '../events';

const TICK_MS = 60_000;
const RETRY_BACKOFF_MS = 30_000;
const METRICS_RETENTION_MS = 8 * 86_400_000;
const ALERTS_RETENTION_MS = 7 * 86_400_000;
const AUDIT_RETENTION_MS = 30 * 86_400_000;
const RUNS_RETENTION_MS = 60 * 86_400_000;

export class Scheduler {
  private lastPrune = 0;

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/kick') {
      const existing = await this.state.storage.getAlarm();
      if (!existing) await this.state.storage.setAlarm(Date.now() + 2_000);
      return new Response('ok');
    }
    if (url.pathname === '/tick') {
      await this.tick();
      return new Response('ok');
    }
    if (url.pathname === '/run-workflow' && request.method === 'POST') {
      const { runId } = (await request.json()) as { runId: string };
      await this.dispatchRoots(runId);
      return new Response('ok');
    }
    if (url.pathname === '/on-task-result' && request.method === 'POST') {
      const body = (await request.json()) as { taskId: string; status: string; exitCode: number | null; error?: string | null };
      await this.onTaskResult(body.taskId, body.status, body.exitCode, body.error ?? null);
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    try {
      await this.tick();
    } finally {
      await this.state.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  // ─── Tick: cron firing + retry dispatch + pruning ─────────────────────

  private async tick(): Promise<void> {
    const now = Date.now();

    // 1. Due cron jobs
    const due = await listCronJobs(this.env.DB, now);
    for (const job of due) {
      const next = nextRun(job.expr, now);
      await updateCronNextRun(this.env.DB, job.id, next, now);
      await this.fireCronJob(job.id, job.expr, job.name);
    }

    // 2. Queued tasks whose retry deadline arrived
    const queued = await this.env.DB
      .prepare(`SELECT * FROM exec_tasks WHERE status = 'queued' AND retry_at IS NOT NULL AND retry_at <= ?`)
      .bind(now)
      .all();
    for (const t of (queued.results ?? []) as { id: string; node_id: string; script: string; lang: string; env_enc: string; timeout_ms: number }[]) {
      const outcome = await dispatchTask(this.env, t, this.env.AUTH_SECRET);
      if (outcome === 'offline') {
        const task = await getTask(this.env.DB, t.id);
        if (task && task.attempts < 3) {
          await this.env.DB
            .prepare(`UPDATE exec_tasks SET retry_at = ? WHERE id = ?`)
            .bind(now + RETRY_BACKOFF_MS, t.id)
            .run();
        } else {
          await finishTask(this.env.DB, t.id, { status: 'failed', exitCode: null, error: 'agent offline' });
        }
      }
    }

    // 3. Hourly retention sweep (all bounded, index/PK-assisted deletes)
    if (now - this.lastPrune > 3_600_000) {
      this.lastPrune = now;
      await pruneMetrics(this.env.DB, METRICS_RETENTION_MS);
      await pruneAlerts(this.env.DB, ALERTS_RETENTION_MS);
      await pruneAudit(this.env.DB, AUDIT_RETENTION_MS);
      await pruneWorkflowRuns(this.env.DB, RUNS_RETENTION_MS);
    }
  }

  private async fireCronJob(jobId: string, expr: string, jobName: string): Promise<void> {
    // re-read the authoritative row (expr may have changed)
    const job = await getCronJob(this.env.DB, jobId);
    if (!job || !job.enabled) return;
    void expr;
    const targets = await nodesMatchingTarget(
      this.env.DB,
      job.target_type as 'node' | 'tag' | 'all',
      job.target_value,
    );
    await audit(this.env.DB, {
      actor: 'scheduler',
      action: 'cron.fire',
      target: job.name,
      detail: `expr=${job.expr} targets=${targets.length}`,
    });
    if (targets.length === 0) {
      await audit(this.env.DB, {
        actor: 'scheduler',
        action: 'cron.no-targets',
        target: job.name,
        detail: 'no online nodes matched',
      });
      return;
    }
    for (const node of targets) {
      const taskId = newId('task');
      await createTask(this.env.DB, {
        id: taskId,
        kind: 'cron',
        refId: jobId,
        nodeId: node.id,
        script: job.script,
        lang: job.lang as 'shell' | 'python',
        envEnc: job.env_enc,
        timeoutMs: job.timeout_ms,
        createdBy: `cron:${job.name}`,
      });
      const outcome = await dispatchTask(this.env, {
        id: taskId,
        node_id: node.id,
        script: job.script,
        lang: job.lang,
        timeout_ms: job.timeout_ms,
        env_enc: job.env_enc,
      }, this.env.AUTH_SECRET);
      if (outcome === 'offline') {
        await finishTask(this.env.DB, taskId, { status: 'failed', exitCode: null, error: 'agent offline at fire time' });
        // let the cron retry policy decide whether to re-queue this task
        await this.onTaskResult(taskId, 'failed', null, 'agent offline at fire time');
      }
    }
  }

  // ─── Workflow runs ────────────────────────────────────────────────────

  private async dispatchRoots(runId: string): Promise<void> {
    const run = await getRun(this.env.DB, runId);
    if (!run || run.status !== 'running') return;
    const graph = JSON.parse(run.graph) as WorkflowGraph;
    const vg = validateGraph(graph);
    if (!vg.ok) return;
    await this.dispatchSteps(runId, vg.roots, vg, graph);
    await pushEvent(this.env, { type: 'run', data: { runId, defId: run.def_id, status: 'running' } });
  }

  private async dispatchSteps(
    runId: string,
    stepIds: string[],
    vg: ValidatedGraph,
    graph: WorkflowGraph,
  ): Promise<void> {
    for (const stepId of stepIds) {
      const node = graph.nodes.find((n) => n.id === stepId);
      if (!node) continue;
      const data = node.data as WorkflowStepData;
      if (data.type === 'webhook') {
        await setStepStatus(this.env.DB, runId, stepId, { status: 'running', started: true });
        const result = await this.executeWebhookNode(data);
        await setStepStatus(this.env.DB, runId, stepId, {
          status: result.ok ? 'success' : 'failed',
          exitCode: result.status ?? null,
          error: result.error ?? null,
          finished: true,
        });
        continue;
      }
      // script step: one task per matched node
      const targets = await nodesMatchingTarget(
        this.env.DB,
        (data.targetType ?? 'node') as 'node' | 'tag' | 'all',
        data.targetValue ?? null,
      );
      if (targets.length === 0) {
        await setStepStatus(this.env.DB, runId, stepId, {
          status: 'failed',
          error: 'no online nodes matched target',
          started: true,
          finished: true,
        });
        continue;
      }
      const taskIds: string[] = [];
      const offlineFails: string[] = [];
      for (const nodeInfo of targets) {
        const taskId = newId('task');
        const envEnc = await encryptEnvObject(this.env, data.env);
        await createTask(this.env.DB, {
          id: taskId,
          kind: 'workflow',
          refId: runId,
          nodeId: nodeInfo.id,
          script: data.script ?? '',
          lang: data.lang ?? 'shell',
          envEnc,
          timeoutMs: data.timeoutMs ?? 300_000,
          createdBy: `workflow:${runId}`,
        });
        taskIds.push(taskId);
        const outcome = await dispatchTask(this.env, {
          id: taskId,
          node_id: nodeInfo.id,
          script: data.script ?? '',
          lang: data.lang ?? 'shell',
          timeout_ms: data.timeoutMs ?? 300_000,
          env_enc: envEnc,
        }, this.env.AUTH_SECRET);
        if (outcome === 'offline') {
          await finishTask(this.env.DB, taskId, { status: 'failed', exitCode: null, error: 'agent offline' });
          offlineFails.push(taskId);
        }
      }
      await setStepStatus(this.env.DB, runId, stepId, { status: 'running', taskIds, started: true });
      // drive the state machine for tasks that could not be dispatched, so the
      // step/run never hangs in "running" after an offline dispatch
      for (const tid of offlineFails) {
        await this.onTaskResult(tid, 'failed', null, 'agent offline');
      }
    }
    await this.refreshRunStatus(runId, vg, graph);
  }

  private async executeWebhookNode(data: WorkflowStepData): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(data.url!, {
        method: data.method ?? 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'OmniMesh-Workflow/1.0' },
        body: data.method === 'GET' ? undefined : data.body ?? JSON.stringify({ source: 'omnimesh', ts: Date.now() }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async refreshRunStatus(runId: string, vg: ValidatedGraph, graph: WorkflowGraph): Promise<void> {
    const steps = await listRunSteps(this.env.DB, runId);
    const states: StepState[] = steps.map((s) => ({
      stepId: s.step_id,
      status: s.status as StepState['status'],
      allTasksDone: true,
      allTasksSuccess: true,
      anyTimeout: false,
      error: s.error,
      exitCode: s.exit_code,
    }));
    const result = advance(vg, states);

    for (const stepId of result.skip) {
      await setStepStatus(this.env.DB, runId, stepId, { status: 'skipped', finished: true });
    }
    if (result.dispatch.length > 0) {
      await this.dispatchSteps(runId, result.dispatch, vg, graph);
    }
    if (result.finished) {
      await this.env.DB
        .prepare(`UPDATE workflow_runs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
        .bind(result.runStatus, Date.now(), runId)
        .run();
      const run = await getRun(this.env.DB, runId);
      if (run) {
        pushEvent(this.env, { type: 'run', data: { runId, defId: run.def_id, status: result.runStatus } });
        await audit(this.env.DB, {
          actor: 'scheduler',
          action: 'workflow.finish',
          target: run.def_name,
          detail: `run=${runId} status=${result.runStatus}`,
        });
      }
    } else {
      const run = await getRun(this.env.DB, runId);
      pushEvent(this.env, { type: 'run', data: { runId, defId: run?.def_id ?? '', status: 'running' } });
    }
  }

  // ─── Task completion ──────────────────────────────────────────────────

  private async onTaskResult(taskId: string, status: string, exitCode: number | null, error: string | null): Promise<void> {
    const task = await getTask(this.env.DB, taskId);
    if (!task) return;

    // 1. Cron retry policy
    if (task.kind === 'cron' && (status === 'failed' || status === 'timeout')) {
      const job = task.ref_id ? await getCronJob(this.env.DB, task.ref_id) : null;
      if (job && job.retries > 0 && task.attempts <= job.retries) {
        const retryId = newId('task');
        await createTask(this.env.DB, {
          id: retryId,
          kind: 'cron',
          refId: job.id,
          nodeId: task.node_id,
          script: task.script,
          lang: task.lang as 'shell' | 'python',
          envEnc: task.env_enc,
          timeoutMs: task.timeout_ms,
          createdBy: `retry-of:${taskId}`,
          retryOf: taskId,
          retryAt: Date.now() + RETRY_BACKOFF_MS,
          status: 'queued',
          attempts: task.attempts,
        });
        pushEvent(this.env, {
          type: 'task',
          data: { taskId: retryId, nodeId: task.node_id, status: 'queued' },
        });
        return; // step advancement not applicable to cron
      }
    }

    // 2. Workflow advancement
    const steps = await findStepsByTask(this.env.DB, taskId);
    const step = steps.find((s) => s.run_id === task.ref_id && s.task_ids.includes(taskId));
    if (step && task.kind === 'workflow') {
      const run = await getRun(this.env.DB, step.run_id);
      if (!run || run.status !== 'running') return;
      const allTaskIds = JSON.parse(step.task_ids) as string[];
      const statuses = await Promise.all(
        allTaskIds.map(async (tid) => {
          const t = await getTask(this.env.DB, tid);
          return t?.status ?? 'running';
        }),
      );
      const allDone = statuses.every((s) => !['queued', 'running'].includes(s));
      if (!allDone) return; // wait for sibling tasks on other nodes
      const stepStatus = statuses.every((s) => s === 'success')
        ? 'success'
        : statuses.includes('timeout')
          ? 'timeout'
          : 'failed';
      await setStepStatus(this.env.DB, step.run_id, step.step_id, {
        status: stepStatus,
        exitCode: exitCode,
        error: error,
        finished: true,
      });
      const graph = JSON.parse(run.graph) as WorkflowGraph;
      const vg = validateGraph(graph);
      if (vg.ok) {
        await this.refreshRunStatus(run.id, vg, graph);
      }
    }
  }
}

/** Encrypt a plain env object with the deployment secret. */
async function encryptEnvObject(env: Env, plain: Record<string, string> | undefined): Promise<string> {
  if (!plain || Object.keys(plain).length === 0) return '';
  return encryptEnv(env.AUTH_SECRET, plain);
}
