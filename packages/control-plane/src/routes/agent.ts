/**
 * Agent-facing endpoints (no JWT): registration with a registration key and
 * the WSS gateway proxied to the node's AgentSession DO.
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../env';
import { ok, fail, agentStub, sha256Hex, clientIp } from '../util';
import { listRegKeys, touchRegKey, upsertNode, audit, getNode } from '../db';
import { signNodeToken } from '../crypto';

export const agentRoutes = new Hono<HonoEnv>();

interface RegisterBody {
  registrationKey?: string;
  name?: string;
  labels?: string[];
  os?: string;
  arch?: string;
  version?: string;
  hostname?: string;
  nodeId?: string; // existing node reconnecting after key rotation
}

agentRoutes.post('/register', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as RegisterBody;
  const rawKey = (body.registrationKey ?? '').trim();
  if (!rawKey) return fail('registrationKey is required', 400);
  const hash = await sha256Hex(rawKey);
  const keys = await listRegKeys(c.env.DB);
  const key = keys.find((k) => k.key_hash === hash && k.enabled === 1);
  if (!key) return fail('invalid registration key', 401);

  // existing node id (token rotation) or a fresh one
  let nodeId = body.nodeId?.trim();
  if (nodeId) {
    const existing = await getNode(c.env.DB, nodeId);
    if (!existing) nodeId = undefined; // unknown id -> register fresh
  }
  if (!nodeId) {
    nodeId = `nd_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
  }
  const labels = Array.isArray(body.labels) ? body.labels.filter((l) => typeof l === 'string' && l.length > 0).slice(0, 10) : [];
  await upsertNode(c.env.DB, nodeId, {
    name: (body.name ?? nodeId).slice(0, 80),
    labels: labels.length ? labels : ['default'],
    os: body.os?.slice(0, 40),
    arch: body.arch?.slice(0, 20),
    version: body.version?.slice(0, 20),
    hostname: body.hostname?.slice(0, 100),
    ip: clientIp(c.req.raw),
  });
  await touchRegKey(c.env.DB, key.id);
  const token = await signNodeToken(c.env.AUTH_SECRET, nodeId);
  await audit(c.env.DB, {
    actor: 'agent',
    action: 'node.register',
    target: body.name ?? nodeId,
    nodeId,
    detail: `key=${key.name} labels=[${labels.join(',')}]`,
    ip: clientIp(c.req.raw),
  });
  return ok({ nodeId, token, heartbeatSec: 15, metricsSec: 30 });
});

agentRoutes.get('/ws', async (c) => {
  const token = c.req.query('token') ?? '';
  if (!token) return fail('token required', 401);
  // The AgentSession DO performs full validation; proxy the upgrade request.
  const stub = agentStub(c.env, token.startsWith('nd_') ? token.slice(0, token.indexOf('.')) : 'unknown');
  const url = new URL(c.req.url);
  const doUrl = `https://agent.internal/ws?token=${encodeURIComponent(token)}`;
  const proxied = new Request(doUrl, {
    method: c.req.method,
    headers: c.req.raw.headers,
  });
  void url;
  return stub.fetch(proxied);
});
