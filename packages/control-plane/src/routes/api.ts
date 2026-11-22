import { Hono } from 'hono';
import type { HonoEnv } from '../env';
import { requireAuth } from '../middleware';
import { ok, fail, id as newId, agentStub, sha256Hex } from '../util';
import {
  deleteNode,
  getNode,
  listNodes,
  queryMetrics,
  deleteRegKey,
  insertRegKey,
  listRegKeys,
  audit,
  encryptEnv,
  createTask,
  listTasks,
  getTask,
  nodesMatchingTarget,
  archiveLog,
  logKey,
  type TaskRow,
} from '../db';
import { dispatchTask } from '../dispatch';
import { randomToken } from '../crypto';
import { pushEvent } from '../events';

export const apiRoutes = new Hono<HonoEnv>();

apiRoutes.use('*', requireAuth());

// ─── Overview ────────────────────────────────────────────────────────────

apiRoutes.get('/overview', async (c) => {
  const nodes = await listNodes(c.env.DB);
  const online = nodes.filter((n) => n.status === 'online');
  const { tasks } = await listTasks(c.env.DB, { limit: 12 });
  const alerts = await listAlertsSafe(c);
  const runningTasks = tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
  const nodesWithMetrics = await Promise.all(
    online.map(async (n) => {
      const m = await latestMetricsFor(c, n.id);
      return { nodeId: n.id, name: n.name, labels: n.labels, metrics: m };
    }),
  );
  return ok({
    stats: {
      nodesTotal: nodes.length,
      nodesOnline: online.length,
      nodesOffline: nodes.length - online.length,
      runningTasks,
      labels: [...new Set(nodes.flatMap((n) => n.labels))],
    },
    live: nodesWithMetrics,
    recentTasks: tasks.map(mapTask),
    alerts,
  });
});

// Cluster CPU history: last 15 minutes in 30s buckets, one series per node.
// Query per node so each statement is a PK-bounded range scan on (node_id, ts)
// — reading only rows inside the window, never the whole metrics table.
apiRoutes.get('/overview/history', async (c) => {
  const nodes = await listNodes(c.env.DB);
  const online = nodes.filter((n) => n.status === 'online');
  const since = Date.now() - 15 * 60_000;
  const byTs = new Map<number, Record<string, number | null>>();
  for (const n of online) {
    const res = await c.env.DB
      .prepare(
        `SELECT (ts / 30000) * 30000 AS b, AVG(cpu) AS cpu FROM metrics
         WHERE node_id = ? AND ts >= ? GROUP BY b ORDER BY b ASC`,
      )
      .bind(n.id, since)
      .all();
    for (const r of (res.results ?? []) as { b: number; cpu: number | null }[]) {
      const ts = r.b; // bucket arithmetic already yields milliseconds
      let row = byTs.get(ts);
      if (!row) {
        row = { ts };
        byTs.set(ts, row);
      }
      row[n.name] = r.cpu;
    }
  }
  return ok({ points: [...byTs.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)) });
});

// ─── Nodes ───────────────────────────────────────────────────────────────

apiRoutes.get('/nodes', async (c) => {
  return ok(await listNodes(c.env.DB));
});

apiRoutes.get('/nodes/:id', async (c) => {
  const node = await getNode(c.env.DB, c.req.param('id'));
  if (!node) return fail('node not found', 404);
  return ok(node);
});

apiRoutes.delete('/nodes/:id', async (c) => {
  const nodeId = c.req.param('id');
  const node = await getNode(c.env.DB, nodeId);
  if (!node) return fail('node not found', 404);
  await deleteNode(c.env.DB, nodeId);
  await audit(c.env.DB, { actor: c.get('session')!.name, action: 'node.delete', target: node.name, nodeId });
  pushEvent(c.env, { type: 'node_status', data: { nodeId, name: node.name, status: 'offline' } });
  return ok(null);
});

// ─── Metrics history ─────────────────────────────────────────────────────

apiRoutes.get('/metrics/:nodeId', async (c) => {
  const range = (c.req.query('range') ?? '1h') as '1h' | '24h' | '7d';
  const points = await queryMetrics(c.env.DB, c.req.param('nodeId'), range);
  const latest = await latestMetricsFor(c, c.req.param('nodeId'));
  return ok({ range, points, latest });
});

// ─── Quick exec ──────────────────────────────────────────────────────────

apiRoutes.post('/exec', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    targetType?: 'node' | 'tag' | 'all';
    targetValue?: string;
    script?: string;
    lang?: 'shell' | 'python';
    timeoutMs?: number;
    env?: Record<string, string>;
  };
  const script = body.script ?? '';
  if (!script.trim()) return fail('script is required', 400);
  const targetType = body.targetType ?? 'node';
  const targets = await nodesMatchingTarget(c.env.DB, targetType, body.targetValue ?? null);
  if (targets.length === 0) return fail('no online node matched the target', 400);

  const envEnc = await encryptEnv(c.env.AUTH_SECRET, body.env);
  const actor = c.get('session')!.name;
  const created: { taskId: string; nodeId: string }[] = [];
  for (const node of targets) {
    const taskId = newId('task');
    await createTask(c.env.DB, {
      id: taskId,
      kind: 'manual',
      nodeId: node.id,
      script,
      lang: body.lang ?? 'shell',
      envEnc,
      timeoutMs: Math.min(body.timeoutMs ?? 120_000, 30 * 60_000),
      createdBy: actor,
    });
    await audit(c.env.DB, {
      actor,
      action: 'exec.dispatch',
      target: node.name,
      nodeId: node.id,
      detail: script.slice(0, 200),
    });
    const outcome = await dispatchTask(c.env, {
      id: taskId,
      node_id: node.id,
      script,
      lang: body.lang ?? 'shell',
      timeout_ms: Math.min(body.timeoutMs ?? 120_000, 30 * 60_000),
      env_enc: envEnc,
    }, c.env.AUTH_SECRET);
    if (outcome === 'offline') {
      await finishTaskSafe(c, taskId, 'agent offline');
    }
    created.push({ taskId, nodeId: node.id });
  }
  return ok({ tasks: created });
});

// ─── Task log access ─────────────────────────────────────────────────────

apiRoutes.get('/tasks/:id/log', async (c) => {
  const task = await getTask(c.env.DB, c.req.param('id'));
  if (!task) return fail('task not found', 404);
  if (task.log_path) {
    const obj = await c.env.LOGS.get(task.log_path);
    if (obj) {
      return new Response(await obj.text(), {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${task.id}.log"` },
      });
    }
  }
  const tail = task.log_tail ?? '';
  return new Response(tail, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${task.id}.log"` },
  });
});

apiRoutes.get('/nodes/:id/files', async (c) => {
  // download a file from the node via FILE_TRANSFER (small files, <8MB)
  const path = c.req.query('path');
  if (!path) return fail('path query parameter required', 400);
  const nodeId = c.req.param('id');
  const res = await agentStub(c.env, nodeId).fetch('https://agent.internal/file-download', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok: boolean; dataB64?: string; error?: string };
  if (!body.ok || !body.dataB64) return fail(body.error ?? 'download failed', 500);
  const bin = base64ToBytes(body.dataB64);
  const filename = path.split(/[/\\]/).pop() ?? 'file';
  return new Response(bin.buffer as ArrayBuffer, {
    headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${filename}"` },
  });
});

apiRoutes.post('/nodes/:id/files', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: string; dataB64?: string };
  if (!body.path || !body.dataB64) return fail('path and dataB64 are required', 400);
  if (body.dataB64.length > 8_000_000) return fail('file too large (limit ~6MB)', 413);
  const nodeId = c.req.param('id');
  const res = await agentStub(c.env, nodeId).fetch('https://agent.internal/file-upload', {
    method: 'POST',
    body: JSON.stringify({ path: body.path, dataB64: body.dataB64 }),
  });
  const out = (await res.json().catch(() => ({}))) as { ok: boolean; received?: number; error?: string };
  if (!out.ok) return fail(out.error ?? 'upload failed', 500);
  return ok({ received: out.received });
});

// ─── Registration keys ───────────────────────────────────────────────────

apiRoutes.get('/keys', async (c) => {
  const keys = await listRegKeys(c.env.DB);
  return ok(
    keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      enabled: k.enabled === 1,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
    })),
  );
});

apiRoutes.post('/keys', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const raw = `omni_${randomToken(18)}`;
  const keyId = newId('key');
  await insertRegKey(c.env.DB, {
    id: keyId,
    name: body.name?.trim() || 'unnamed key',
    key_hash: await sha256Hex(raw),
    prefix: raw.slice(0, 12),
    enabled: 1,
    created_at: Date.now(),
    last_used_at: null,
  });
  await audit(c.env.DB, { actor: c.get('session')!.name, action: 'key.create', target: body.name ?? 'unnamed key' });
  return ok({ id: keyId, key: raw }); // raw key is shown exactly once
});

apiRoutes.delete('/keys/:id', async (c) => {
  await deleteRegKey(c.env.DB, c.req.param('id'));
  await audit(c.env.DB, { actor: c.get('session')!.name, action: 'key.revoke', target: c.req.param('id') });
  return ok(null);
});

// ─── Diagnostics (ops tooling) ───────────────────────────────────────────

// Fingerprint-only view of bound secrets: length + SHA-256, never plaintext.
apiRoutes.get('/debug/env', async (c) => {
  const fingerprint = async (v: string | undefined) => {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v ?? ''));
    let s = '';
    for (const b of new Uint8Array(h)) s += b.toString(16).padStart(2, '0');
    return { len: (v ?? '').length, sha256: s };
  };
  return ok({
    ADMIN_PASSWORD: await fingerprint(c.env.ADMIN_PASSWORD),
    AUTH_SECRET: await fingerprint(c.env.AUTH_SECRET),
    DEFAULT_REG_KEY: await fingerprint(c.env.DEFAULT_REG_KEY),
  });
});

apiRoutes.get('/debug/r2', async (c) => {
  try {
    await c.env.LOGS.put('debug/ping', 'ok');
    const obj = await c.env.LOGS.get('debug/ping');
    const text = obj ? await obj.text() : null;
    // exercise the exact archiving path used for exec logs
    const sample = 'x'.repeat(100_000);
    const key = logKey('debug-archtest');
    const t0 = Date.now();
    await archiveLog(c.env.LOGS, key, sample);
    const obj2 = await c.env.LOGS.get(key);
    const size2 = obj2 ? (await obj2.arrayBuffer()).byteLength : 0;
    return ok({
      put: true,
      get: text,
      archive: { key, size: size2, ms: Date.now() - t0, matches: size2 === sample.length },
    });
  } catch (e) {
    return ok({
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? (e.stack ?? '').slice(0, 600) : undefined,
    });
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────

async function listAlertsSafe(c: { env: HonoEnv['Bindings'] }) {
  const { listAlerts } = await import('../db');
  const alerts = (await listAlerts(c.env.DB, 10)) as { id: string; ts: number; level: string; title: string; message: string; node_id: string | null; notified: number }[];
  return alerts.map((a) => ({ id: a.id, ts: a.ts, level: a.level, title: a.title, message: a.message, nodeId: a.node_id, notified: a.notified === 1 }));
}

async function latestMetricsFor(c: { env: HonoEnv['Bindings'] }, nodeId: string) {
  const { latestMetrics } = await import('../db');
  const m = await latestMetrics(c.env.DB, nodeId);
  if (!m) return null;
  return {
    ts: m.ts,
    cpu: m.cpu,
    memUsed: m.mem_used,
    memTotal: m.mem_total,
    diskTotal: m.disk_total,
    diskUsed: m.disk_used,
    diskReadBps: m.disk_read_bps,
    diskWriteBps: m.disk_write_bps,
    netInBps: m.net_in_bps,
    netOutBps: m.net_out_bps,
    load1: m.load1,
    procs: m.procs,
    uptime: m.uptime,
  };
}

function mapTask(t: TaskRow) {
  return {
    id: t.id,
    kind: t.kind,
    refId: t.ref_id,
    nodeId: t.node_id,
    script: t.script,
    lang: t.lang,
    status: t.status,
    exitCode: t.exit_code,
    attempts: t.attempts,
    logSize: t.log_size,
    logTail: t.log_tail,
    error: t.error,
    createdAt: t.created_at,
    startedAt: t.started_at,
    finishedAt: t.finished_at,
  };
}

async function finishTaskSafe(c: { env: HonoEnv['Bindings'] }, taskId: string, error: string): Promise<void> {
  const { finishTask } = await import('../db');
  await finishTask(c.env.DB, taskId, { status: 'failed', exitCode: null, error });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
