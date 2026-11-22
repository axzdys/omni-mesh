import { Hono } from 'hono';
import type { HonoEnv } from '../env';
import { requireAuth } from '../middleware';
import { ok, fail, id as newId, schedulerStub } from '../util';
import { createWorkflowDef, updateWorkflowDef, deleteWorkflowDef, listWorkflowDefs, getWorkflowDef, audit } from '../db';
import { validateGraph } from '../dag';
import { pushEvent } from '../events';
import { z } from 'zod';

export const workflowRoutes = new Hono<HonoEnv>();

workflowRoutes.use('*', requireAuth());

const defSchema = z.object({
  name: z.string().min(1).max(120),
  graph: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        position: z.object({ x: z.number(), y: z.number() }).optional(),
        data: z.object({
          label: z.string().optional(),
          type: z.enum(['script', 'webhook']),
          targetType: z.enum(['node', 'tag', 'all']).optional(),
          targetValue: z.string().nullish(),
          script: z.string().optional(),
          lang: z.enum(['shell', 'python']).optional(),
          timeoutMs: z.number().optional(),
          retries: z.number().optional(),
          env: z.record(z.string()).optional(),
          onFailure: z.enum(['stop', 'continue']).optional(),
          url: z.string().optional(),
          method: z.enum(['GET', 'POST', 'PUT']).optional(),
          body: z.string().optional(),
        }),
      }),
    ),
    edges: z.array(z.object({ id: z.string(), source: z.string(), target: z.string() })),
  }),
});

workflowRoutes.get('/', async (c) => {
  const defs = await listWorkflowDefs(c.env.DB);
  return ok(
    defs.map((d) => ({
      id: d.id,
      name: d.name,
      graph: JSON.parse(d.graph),
      enabled: d.enabled === 1,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    })),
  );
});

workflowRoutes.post('/validate', async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown;
  const v = validateGraph(body);
  if (!v.ok) return ok({ valid: false, issues: v.issues });
  return ok({ valid: true, issues: [] });
});

workflowRoutes.post('/', async (c) => {
  const parsed = defSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'invalid body', 400);
  const v = validateGraph(parsed.data.graph);
  if (!v.ok) return fail(v.issues.map((i) => i.message).join('; '), 400);
  const defId = newId('wf');
  await createWorkflowDef(c.env.DB, {
    id: defId,
    name: parsed.data.name,
    graph: JSON.stringify(parsed.data.graph),
    enabled: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  await audit(c.env.DB, { actor: c.get('session')!.name, action: 'workflow.create', target: parsed.data.name });
  return ok({ id: defId });
});

workflowRoutes.put('/:id', async (c) => {
  const parsed = defSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'invalid body', 400);
  const v = validateGraph(parsed.data.graph);
  if (!v.ok) return fail(v.issues.map((i) => i.message).join('; '), 400);
  await updateWorkflowDef(c.env.DB, c.req.param('id'), {
    name: parsed.data.name,
    graph: JSON.stringify(parsed.data.graph),
    updated_at: Date.now(),
  });
  await audit(c.env.DB, { actor: c.get('session')!.name, action: 'workflow.update', target: parsed.data.name });
  return ok(null);
});

workflowRoutes.delete('/:id', async (c) => {
  await deleteWorkflowDef(c.env.DB, c.req.param('id'));
  await audit(c.env.DB, { actor: c.get('session')!.name, action: 'workflow.delete', target: c.req.param('id') });
  return ok(null);
});

workflowRoutes.post('/:id/run', async (c) => {
  const def = await getWorkflowDef(c.env.DB, c.req.param('id'));
  if (!def) return fail('workflow not found', 404);
  const graph = JSON.parse(def.graph) as { nodes: { id: string; data: { label?: string; type: string } }[] };
  const v = validateGraph(graph);
  if (!v.ok) return fail(v.issues.map((i) => i.message).join('; '), 400);

  const runId = newId('run');
  await c.env.DB
    .prepare(`INSERT INTO workflow_runs (id, def_id, def_name, graph, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)`)
    .bind(runId, def.id, def.name, def.graph, Date.now())
    .run();
  for (const node of graph.nodes) {
    await c.env.DB
      .prepare(`INSERT INTO run_steps (run_id, step_id, label, type, status, task_ids) VALUES (?, ?, ?, ?, 'pending', '[]')`)
      .bind(runId, node.id, node.data.label ?? node.id, node.data.type)
      .run();
  }
  await audit(c.env.DB, { actor: c.get('session')!.name, action: 'workflow.run', target: def.name, detail: runId });
  await schedulerStub(c.env).fetch('https://scheduler.internal/run-workflow', {
    method: 'POST',
    body: JSON.stringify({ runId }),
  });
  pushEvent(c.env, { type: 'run', data: { runId, defId: def.id, status: 'running' } });
  return ok({ runId });
});

workflowRoutes.get('/runs', async (c) => {
  const defId = c.req.query('defId');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '30', 10), 100);
  const where = defId ? 'WHERE def_id = ?' : '';
  const res = await c.env.DB
    .prepare(`SELECT * FROM workflow_runs ${where} ORDER BY created_at DESC LIMIT ?`)
    .bind(...(defId ? [defId] : []), limit)
    .all();
  const runs = (res.results ?? []) as { id: string; def_id: string; def_name: string; status: string; created_at: number; finished_at: number | null }[];
  return ok(runs.map((r) => ({ id: r.id, defId: r.def_id, defName: r.def_name, status: r.status, createdAt: r.created_at, finishedAt: r.finished_at })));
});

workflowRoutes.get('/runs/:id', async (c) => {
  const runId = c.req.param('id');
  const run = await c.env.DB.prepare('SELECT * FROM workflow_runs WHERE id = ?').bind(runId).all();
  const r = (run.results ?? [])[0] as { id: string; def_id: string; def_name: string; graph: string; status: string; created_at: number; finished_at: number | null } | undefined;
  if (!r) return fail('run not found', 404);
  const stepsRes = await c.env.DB.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY started_at ASC, step_id ASC').bind(runId).all();
  const steps = (stepsRes.results ?? []) as { step_id: string; label: string; type: string; status: string; task_ids: string; exit_code: number | null; error: string | null; started_at: number | null; finished_at: number | null }[];
  return ok({
    id: r.id,
    defId: r.def_id,
    defName: r.def_name,
    status: r.status,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    graph: JSON.parse(r.graph),
    steps: steps.map((s) => ({
      stepId: s.step_id,
      label: s.label,
      type: s.type,
      status: s.status,
      taskIds: JSON.parse(s.task_ids) as string[],
      exitCode: s.exit_code,
      error: s.error,
      startedAt: s.started_at,
      finishedAt: s.finished_at,
    })),
  });
});
