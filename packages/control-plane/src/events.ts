/**
 * Push live events to all connected dashboard sockets via the EventsHub DO.
 * The caller supplies env; failures are swallowed (events are best-effort).
 */

import type { DashEvent } from '@omni/shared';
import type { Env } from './env';
import { eventsStub } from './util';

export function pushEvent(env: Env, ev: DashEvent): void {
  eventsStub(env)
    .fetch('https://events.internal/push', {
      method: 'POST',
      body: JSON.stringify(ev),
    })
    .catch(() => {});
}
