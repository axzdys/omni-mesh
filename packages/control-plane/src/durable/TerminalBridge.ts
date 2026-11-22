/**
 * TerminalBridge — one DO per WebSSH session (name = ptyId). Bridges the
 * browser WebSocket to the agent's PTY through the node's AgentSession DO.
 *
 * Browser → server:  binary frames = PTY stdin bytes; text JSON = ctl
 * Server → browser:  binary frames = PTY stdout bytes; text JSON = ctl
 */

import type { Env } from '../env';
import { agentStub, clientIp } from '../util';
import { audit, closeTerminalSession } from '../db';

export class TerminalBridge {
  private browserWs: WebSocket | null = null;
  private ptyId: string | null = null;
  private nodeId: string | null = null;
  private actor = 'anonymous';
  private open = false;

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return this.handleBrowserWs(request);

    if (url.pathname === '/agent-data' && request.method === 'POST') {
      const buf = await request.arrayBuffer();
      
      if (this.browserWs && this.open) {
        try {
          this.browserWs.send(buf);
        } catch {
          /* browser gone */
        }
      }
      return new Response('ok');
    }

    if (url.pathname === '/agent-closed' && request.method === 'POST') {
      const { reason } = (await request.json()) as { reason: string };
      this.notifyClosed(reason);
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }

  private async handleBrowserWs(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.nodeId = url.searchParams.get('nodeId') ?? '';
    // ptyId doubles as this bridge's DO name so PTY frames route back here
    this.ptyId = url.searchParams.get('ptyId') ?? this.state.id.toString();
    this.actor = url.searchParams.get('actor') ?? 'anonymous';
    const cols = parseInt(url.searchParams.get('cols') ?? '80', 10) || 80;
    const rows = parseInt(url.searchParams.get('rows') ?? '24', 10) || 24;
    const shell = url.searchParams.get('shell') ?? undefined;

    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    this.browserWs = server;

    server.addEventListener('message', (ev: MessageEvent) => {
      if (!this.open) return;
      try {
        if (typeof ev.data === 'string') {
          void this.handleCtl(ev.data).catch(() => {});
        } else if (ev.data instanceof ArrayBuffer) {

          void agentStub(this.env, this.nodeId!)
            .fetch('https://agent.internal/pty-input', {
              method: 'POST',
              body: ev.data,
              headers: { 'content-type': 'application/octet-stream', 'x-omni-pty': this.ptyId! },
            })
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }
    });

    server.addEventListener('close', () => {
      void this.teardown('client disconnected');
    });

    server.addEventListener('error', () => {
      void this.teardown('client error');
    });

    // Open the PTY on the agent (retry briefly to ride out agent reconnects)
    let opened = false;
    let lastErr = 'agent offline';
    for (let attempt = 0; attempt < 4 && !opened; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1500));
      }
      try {
        const res = await agentStub(this.env, this.nodeId).fetch('https://agent.internal/pty-attach', {
          method: 'POST',
          body: JSON.stringify({ ptyId: this.ptyId, cols, rows, shell }),
        });
        if (res.ok) {
          opened = true;
          break;
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        lastErr = body.error ?? `agent offline (${res.status})`;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : 'bridge error';
      }
    }
    if (opened) {
      this.open = true;
      this.sendCtl({ type: 'open', ok: true });
      await this.env.DB.prepare(
        'INSERT INTO terminal_sessions (id, node_id, actor, opened_at) VALUES (?, ?, ?, ?)',
      )
        .bind(this.ptyId, this.nodeId, this.actor, Date.now())
        .run();
      await audit(this.env.DB, {
        actor: this.actor,
        action: 'terminal.open',
        target: this.nodeId,
        nodeId: this.nodeId,
        ip: clientIp(request),
      });
    } else {
      this.sendCtl({ type: 'open', ok: false, reason: lastErr });
      await this.teardown('agent offline');
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async handleCtl(raw: string): Promise<void> {
    let ctl: { type: string; cols?: number; rows?: number };
    try {
      ctl = JSON.parse(raw);
    } catch {
      return;
    }
    if (ctl.type === 'ping') {
      this.sendCtl({ type: 'pong' });
      return;
    }
    if (ctl.type === 'resize' && ctl.cols && ctl.rows) {
      await agentStub(this.env, this.nodeId!).fetch('https://agent.internal/pty-resize', {
        method: 'POST',
        body: JSON.stringify({ ptyId: this.ptyId, cols: ctl.cols, rows: ctl.rows }),
      });
      return;
    }
    if (ctl.type === 'close') {
      await this.teardown('client requested close');
    }
  }

  private sendCtl(ctl: { type: string; ok?: boolean; reason?: string }): void {
    try {
      this.browserWs?.send(JSON.stringify(ctl));
    } catch {
      /* noop */
    }
  }

  private notifyClosed(reason: string): void {
    this.sendCtl({ type: 'closed', reason });
    this.open = false;
  }

  private async teardown(reason: string): Promise<void> {
    if (!this.open && !this.browserWs) return;
    this.open = false;
    const ws = this.browserWs;
    this.browserWs = null;
    try {
      ws?.close(1000, reason);
    } catch {
      /* noop */
    }
    if (this.ptyId && this.nodeId) {
      await agentStub(this.env, this.nodeId)
        .fetch('https://agent.internal/pty-close', { method: 'POST', body: JSON.stringify({ ptyId: this.ptyId }) })
        .catch(() => {});
      await closeTerminalSession(this.env.DB, this.ptyId).catch(() => {});
      await audit(this.env.DB, {
        actor: this.actor,
        action: 'terminal.close',
        target: this.nodeId,
        nodeId: this.nodeId,
        detail: reason,
      }).catch(() => {});
    }
  }
}
