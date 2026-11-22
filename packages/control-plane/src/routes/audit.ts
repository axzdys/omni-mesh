import { Hono } from 'hono';
import type { HonoEnv } from '../env';
import { requireAuth } from '../middleware';
import { ok } from '../util';
import { listAudit } from '../db';

export const auditRoutes = new Hono<HonoEnv>();

auditRoutes.use('*', requireAuth());

auditRoutes.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const { entries, total } = await listAudit(c.env.DB, {
    action: c.req.query('action') || undefined,
    nodeId: c.req.query('nodeId') || undefined,
    search: c.req.query('search') || undefined,
    limit,
    offset,
  });
  return ok({
    total,
    entries: entries.map((e) => ({
      id: e.id,
      ts: e.ts,
      actor: e.actor,
      action: e.action,
      target: e.target,
      nodeId: e.node_id,
      detail: e.detail,
      ip: e.ip,
    })),
  });
});
