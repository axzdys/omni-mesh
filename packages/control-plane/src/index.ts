/**
 * Worker entry: exports the fetch handler, scheduled handler and all
 * Durable Object classes.
 */

import { buildApp } from './app';
import type { Env } from './env';
import { schedulerStub } from './util';

export { AgentSession } from './durable/AgentSession';
export { TerminalBridge } from './durable/TerminalBridge';
export { LogHub } from './durable/LogHub';
export { EventsHub } from './durable/EventsHub';
export { Scheduler } from './durable/Scheduler';

const app = buildApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await app.fetch(request, env, ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? (e.stack ?? '').slice(0, 800) : '';
      console.error('worker fetch error:', msg, stack);
      return new Response(JSON.stringify({ ok: false, error: msg, stack }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await schedulerStub(env).fetch('https://scheduler.internal/tick', { method: 'POST' });
    } catch (e) {
      console.error('scheduled tick failed', e);
    }
  },
};
