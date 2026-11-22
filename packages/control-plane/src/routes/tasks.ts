import { Hono } from 'hono';
import type { HonoEnv } from '../env';
import { requireAuth } from '../middleware';
import { ok, fail, id as newId } from '../util';
import { listTasks, getTask, finishTask, audit } from '../db';
import { cancelExecTask } from '../dispatch';
import { z } from 'zod';

export const taskRoutes = new Hono<HonoEnv>();

taskRoutes.use('*', requireAuth());

taskRoutes.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const { tasks, total } = await listTasks(c.env.DB, {
    nodeId: c.req.query('nodeId') || undefined,
    status: (c.req.query('status') || undefined) as never,
    kind: c.req.query('kind') || undefined,
    refId: c.req.query('refId') || undefined,
    limit,
    offset,
  });
  return ok({
    total,
    tasks: tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      refId: t.ref_id,
      nodeId: t.node_id,
      script: t.script,
      lang: t.lang,
      status: t.status,
      exitCode: t.exit_code,
      attempts: t.attempts,
      timeoutMs: t.timeout_ms,
      logSize: t.log_size,
      logTail: t.log_tail,
      error: t.error,
      createdBy: t.created_by,
      createdAt: t.created_at,
      startedAt: t.started_at,
      finishedAt: t.finished_at,
    })),
  });
});

taskRoutes.get('/:id', async (c) => {
  const t = await getTask(c.env.DB, c.req.param('id'));
  if (!t) return fail('task not found', 404);
  return ok({
    id: t.id,
    kind: t.kind,
    refId: t.ref_id,
    nodeId: t.node_id,
    script: t.script,
    lang: t.lang,
    status: t.status,
    exitCode: t.exit_code,
    attempts: t.attempts,
    timeoutMs: t.timeout_ms,
    logSize: t.log_size,
    logPath: t.log_path,
    logTail: t.log_tail,
    error: t.error,
    createdBy: t.created_by,
    createdAt: t.created_at,
    startedAt: t.started_at,
    finishedAt: t.finished_at,
  });
});

taskRoutes.post('/:id/cancel', async (c) => {
  const t = await getTask(c.env.DB, c.req.param('id'));
  if (!t) return fail('task not found', 404);
  if (t.status !== 'running' && t.status !== 'queued') return fail('task is not running', 409);
  await cancelExecTask(c.env, t.id);
  if (t.status === 'queued') {
    await finishTask(c.env.DB, t.id, { status: 'cancelled', exitCode: null, error: 'cancelled before dispatch' });
  }
  await audit(c.env.DB, {
    actor: c.get('session')!.name,
    action: 'exec.cancel',
    target: t.id,
    nodeId: t.node_id,
  });
  return ok(null);
});

const cronCreate = z.object({
  name: z.string().min(1).max(120),
  expr: z.string().min(1).max(100),
  targetType: z.enum(['node', 'tag', 'all']),
  targetValue: z.string().nullish(),
  script: z.string().min(1),
  lang: z.enum(['shell', 'python']).default('shell'),
  timeoutMs: z.number().int().min(1000).max(3600_000).default(600_000),
  retries: z.number().int().min(0).max(10).default(0),
  env: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
});

export const cronRoutes = new Hono<HonoEnv>();

cronRoutes.use('*', requireAuth());

function mapCron(j: Record<string, unknown>) {
  return {
    id: j.id,
    name: j.name,
    expr: j.expr,
    targetType: j.target_type,
    targetValue: j.target_value,
    script: j.script,
    lang: j.lang,
    timeoutMs: j.timeout_ms,
    retries: j.retries,
    enabled: j.enabled === 1,
    nextRun: j.next_run,
    lastRun: j.last_run,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}

cronRoutes.get('/', async (c) => {
  const { listCronJobs } = await import('../db');
  const jobs = await listCronJobs(c.env.DB);
  return ok(jobs.map((j) => mapCron(j as unknown as Record<string, unknown>)));
});

cronRoutes.post('/preview', async (c) => {
  const { expr } = (await c.req.json()) as { expr: string };
  const { previewCron } = await import('../cron');
  const res = previewCron(expr, Date.now(), 5);
  if (typeof res === 'string') return fail(res, 400);
  return ok({ next: res });
});

cronRoutes.post('/', async (c) => {
  const parsed = cronCreate.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'invalid body', 400);
  const data = parsed.data;
  const { nextRun, validateCron } = await import('../cron');
  const err = validateCron(data.expr);
  if (err) return fail(err, 400);
  const jobId = newId('cron');
  const { insertCronJob, encryptEnv } = await import('../db');
  await insertCronJob(c.env.DB, {
    id: jobId,
    name: data.name,
    expr: data.expr,
    target_type: data.targetType,
    target_value: data.targetValue ?? null,
    script: data.script,
    lang: data.lang,
    timeout_ms: data.timeoutMs,
    retries: data.retries,
    env_enc: await encryptEnv(c.env.AUTH_SECRET, data.env),
    enabled: data.enabled ? 1 : 0,
    next_run: nextRun(data.expr, Date.now()),
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  await audit(c.env.DB, {
    actor: c.get('session')!.name,
    action: 'cron.create',
    target: data.name,
    detail: `expr=${data.expr}`,
  });
  return ok({ id: jobId });
});

cronRoutes.put('/:id', async (c) => {
  const parsed = cronCreate.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'invalid body', 400);
  const data = parsed.data;
  const { validateCron, nextRun } = await import('../cron');
  const err = validateCron(data.expr);
  if (err) return fail(err, 400);
  const { updateCronJob, encryptEnv } = await import('../db');
  await updateCronJob(c.env.DB, c.req.param('id'), {
    name: data.name,
    expr: data.expr,
    target_type: data.targetType,
    target_value: data.targetValue ?? null,
    script: data.script,
    lang: data.lang,
    timeout_ms: data.timeoutMs,
    retries: data.retries,
    env_enc: await encryptEnv(c.env.AUTH_SECRET, data.env),
    enabled: data.enabled ? 1 : 0,
    next_run: nextRun(data.expr, Date.now()),
    updated_at: Date.now(),
  });
  await audit(c.env.DB, { actor: c.get('session')!.name, action: 'cron.update', target: data.name });
  return ok(null);
});

cronRoutes.delete('/:id', async (c) => {
  const { deleteCronJob } = await import('../db');
  await deleteCronJob(c.env.DB, c.req.param('id'));
  await audit(c.env.DB, { actor: c.get('session')!.name, action: 'cron.delete', target: c.req.param('id') });
  return ok(null);
});

cronRoutes.post('/:id/toggle', async (c) => {
  const { toggleCronJob } = await import('../db');
  const enabled = await toggleCronJob(c.env.DB, c.req.param('id'));
  await audit(c.env.DB, {
    actor: c.get('session')!.name,
    action: 'cron.toggle',
    target: c.req.param('id'),
    detail: `enabled=${enabled}`,
  });
  return ok({ enabled });
});

cronRoutes.post('/:id/run', async (c) => {
  // run now: create tasks immediately without waiting for the schedule
  const { getCronJob, nodesMatchingTarget, createTask, encryptEnv } = await import('../db');
  const job = await getCronJob(c.env.DB, c.req.param('id'));
  if (!job) return fail('job not found', 404);
  const targets = await nodesMatchingTarget(c.env.DB, job.target_type as 'node' | 'tag' | 'all', job.target_value);
  if (targets.length === 0) return fail('no online node matched the target', 400);
  const { dispatchTask } = await import('../dispatch');
  const created: string[] = [];
  for (const node of targets) {
    const taskId = newId('task');
    await createTask(c.env.DB, {
      id: taskId,
      kind: 'cron',
      refId: job.id,
      nodeId: node.id,
      script: job.script,
      lang: job.lang as 'shell' | 'python',
      envEnc: job.env_enc,
      timeoutMs: job.timeout_ms,
      createdBy: `cron-manual:${job.name}`,
    });
    created.push(taskId);
    const outcome = await dispatchTask(c.env, {
      id: taskId,
      node_id: node.id,
      script: job.script,
      lang: job.lang,
      timeout_ms: job.timeout_ms,
      env_enc: job.env_enc,
    }, c.env.AUTH_SECRET);
    if (outcome === 'offline') {
      await finishTask(c.env.DB, taskId, { status: 'failed', exitCode: null, error: 'agent offline' });
    }
  }
  await audit(c.env.DB, {
    actor: c.get('session')!.name,
    action: 'cron.run-now',
    target: job.name,
    detail: `${created.length} task(s)`,
  });
  return ok({ taskIds: created });
});
