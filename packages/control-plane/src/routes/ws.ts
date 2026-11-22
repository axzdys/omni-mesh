/**
 * Dashboard WebSocket endpoints:
 *   GET /api/ws/events            → EventsHub singleton (global live feed)
 *   GET /api/ws/task/:taskId      → LogHub (live exec log)
 *   GET /api/ws/terminal/:nodeId  → TerminalBridge (WebSSH)
 * All authenticate via ?token=<JWT>.
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../env';
import { jwtVerify } from '../crypto';
import { eventsStub, logHubStub, terminalStub, id as newId } from '../util';

export const wsRoutes = new Hono<HonoEnv>();

async function authQueryToken(c: { env: HonoEnv['Bindings']; req: { query: (k: string) => string | undefined } }): Promise<{ sub: string; name: string } | null> {
  const token = c.req.query('token') ?? '';
  if (!token) return null;
  const claims = await jwtVerify(c.env.AUTH_SECRET, token);
  return claims ? { sub: claims.sub, name: claims.name } : null;
}

wsRoutes.get('/events', async (c) => {
  const session = await authQueryToken(c);
  if (!session) return new Response('unauthorized', { status: 401 });
  const proxied = new Request('https://events.internal/ws', { headers: c.req.raw.headers });
  return eventsStub(c.env).fetch(proxied);
});

wsRoutes.get('/task/:taskId', async (c) => {
  const session = await authQueryToken(c);
  if (!session) return new Response('unauthorized', { status: 401 });
  const taskId = c.req.param('taskId');
  const proxied = new Request(`https://loghub.internal/ws?task=${encodeURIComponent(taskId)}`, { headers: c.req.raw.headers });
  return logHubStub(c.env, taskId).fetch(proxied);
});

wsRoutes.get('/terminal/:nodeId', async (c) => {
  const session = await authQueryToken(c);
  if (!session) return new Response('unauthorized', { status: 401 });
  const nodeId = c.req.param('nodeId');
  const termId = newId('term');
  const q = new URL(c.req.url).searchParams;
  const params = new URLSearchParams({
    nodeId,
    // the bridge must know its own DO *name* (not the hashed id) so the agent
    // session can route PTY frames back to this exact instance
    ptyId: termId,
    actor: session.name,
    cols: q.get('cols') ?? '80',
    rows: q.get('rows') ?? '24',
  });
  const shell = q.get('shell');
  if (shell) params.set('shell', shell);
  const proxied = new Request(`https://terminal.internal/ws?${params.toString()}`, { headers: c.req.raw.headers });
  return terminalStub(c.env, termId).fetch(proxied);
});
