/**
 * Hono application assembly.
 */

import { Hono } from 'hono';
import type { HonoEnv } from './env';
import { ensureBootstrap } from './bootstrap';
import { authRoutes } from './routes/auth';
import { apiRoutes } from './routes/api';
import { taskRoutes, cronRoutes } from './routes/tasks';
import { workflowRoutes } from './routes/workflows';
import { auditRoutes } from './routes/audit';
import { settingsRoutes } from './routes/settings';
import { agentRoutes } from './routes/agent';
import { wsRoutes } from './routes/ws';
import { schedulerStub } from './util';
import { fail } from './util';

let bootstrapped = false;

export function buildApp() {
  const app = new Hono<HonoEnv>();

  // one-time bootstrap (idempotent; retried on failure so a transient error
  // — e.g. a CPU-limit throw during password hashing — never leaves the
  // instance without an admin account)
  app.use('*', async (c, next) => {
    if (!bootstrapped) {
      try {
        await ensureBootstrap(c.env.DB, c.env);
        await schedulerStub(c.env).fetch('https://scheduler.internal/kick', { method: 'POST' });
        bootstrapped = true;
      } catch (e) {
        console.error('bootstrap failed, will retry on next request:', e instanceof Error ? e.message : e);
      }
    }
    await next();
  });

  // health & meta
  app.get('/api/health', (c) => c.json({ ok: true, service: 'omni-mesh-control-plane', ts: Date.now() }));

  // dashboard auth (login is public, rest of /api/auth requires JWT)
  app.route('/api/auth', authRoutes);

  // everything else under /api requires a session
  app.route('/api', apiRoutes); // overview, nodes, metrics, exec, keys
  app.route('/api/tasks', taskRoutes);
  app.route('/api/cron', cronRoutes);
  app.route('/api/workflows', workflowRoutes);
  app.route('/api/audit', auditRoutes);
  app.route('/api/settings', settingsRoutes);

  // websocket endpoints (JWT via query param)
  app.route('/api/ws', wsRoutes);

  // agent-facing
  app.route('/agent', agentRoutes);

  // 404 for unknown API paths
  app.all('/api/*', (c) => fail('not found', 404));
  app.all('/agent/*', (c) => fail('not found', 404));

  // SPA fallback: GETs that didn't match API routes and weren't served by
  // assets directly are routed to the dashboard shell.
  app.get('*', async (c) => {
    try {
      const res = await c.env.ASSETS.fetch(c.req.raw);
      if (res.status !== 404) return res;
      const index = await c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url).toString()));
      return new Response(index.body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    } catch {
      return fail('asset lookup failed', 500);
    }
  });

  return app;
}
