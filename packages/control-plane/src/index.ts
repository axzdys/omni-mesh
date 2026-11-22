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
    return app.fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await schedulerStub(env).fetch('https://scheduler.internal/tick', { method: 'POST' });
    } catch (e) {
      console.error('scheduled tick failed', e);
    }
  },
};
