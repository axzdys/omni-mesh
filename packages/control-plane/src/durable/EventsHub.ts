/**
 * EventsHub — singleton DO ("events") holding every dashboard socket that
 * wants the global live event stream (node status, metrics, task/run updates,
 * alerts).
 */

import type { DashEvent } from '@omni/shared';
import type { Env } from '../env';

export class EventsHub {
  private sockets = new Set<WebSocket>();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      this.sockets.add(server);
      server.addEventListener('close', () => this.sockets.delete(server));
      server.addEventListener('error', () => this.sockets.delete(server));
      try {
        server.send(JSON.stringify({ type: 'hello', data: { ts: Date.now() } } satisfies DashEvent));
      } catch {
        /* noop */
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === '/push' && request.method === 'POST') {
      const frame = await request.text();
      for (const ws of this.sockets) {
        try {
          ws.send(frame);
        } catch {
          /* drop */
        }
      }
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }
}
