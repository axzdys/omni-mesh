/**
 * LogHub — one DO per exec task (name = taskId). Fans out live stdout/stderr
 * chunks to any dashboard sockets watching the task, and sends the terminal
 * result before closing all sockets.
 */

import type { Env } from '../env';
import { getTask } from '../db';

export class LogHub {
  private sockets = new Set<WebSocket>();

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

      // late joiners get the tail stored in D1
      const taskId = this.state.id.toString();
      const task = await getTask(this.env.DB, taskId);
      if (task?.log_tail) {
        try {
          server.send(JSON.stringify({ type: 'tail', data: task.log_tail }));
        } catch {
          /* noop */
        }
      }
      if (task && task.status !== 'queued' && task.status !== 'running') {
        try {
          server.send(
            JSON.stringify({
              type: 'result',
              status: task.status,
              exitCode: task.exit_code,
              durationMs: (task.finished_at ?? 0) - (task.started_at ?? task.created_at),
              error: task.error ?? undefined,
            }),
          );
        } catch {
          /* noop */
        }
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === '/stream' && request.method === 'POST') {
      const body = (await request.json()) as { stream: 'out' | 'err'; dataB64: string };
      const frame = JSON.stringify({ type: 'stream', stream: body.stream, dataB64: body.dataB64 });
      for (const ws of this.sockets) {
        try {
          ws.send(frame);
        } catch {
          /* drop */
        }
      }
      return new Response('ok');
    }

    if (url.pathname === '/result' && request.method === 'POST') {
      const body = (await request.json()) as { status: string; exitCode: number | null; durationMs: number; error?: string };
      const frame = JSON.stringify({ type: 'result', ...body });
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
