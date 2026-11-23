/**
 * TerminalBridge — one DO per WebSSH session (name = ptyId). Bridges the
 * browser WebSocket to the agent's PTY through the node's AgentSession DO.
 *
 * Uses the WebSocket Hibernation API: the browser socket is accepted with
 * `state.acceptWebSocket()` and session metadata is stored as a socket
 * attachment, so an idle terminal costs zero DO duration.
 *
 * Browser → server:  binary frames = PTY stdin bytes; text JSON = ctl
 * Server → browser:  binary frames = PTY stdout bytes; text JSON = ctl
 */

import type { Env } from '../env';
import { agentStub, clientIp } from '../util';
import { audit, closeTerminalSession } from '../db';

interface BridgeAttachment {
  nodeId: string;
  ptyId: string;
  actor: string;
  open: boolean;
}

export class TerminalBridge {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return this.handleBrowserWs(request);

    if (url.pathname === '/agent-data' && request.method === 'POST') {
      const buf = await request.arrayBuffer();
      const ws = this.browserSocket();
      if (ws) {
        try {
          ws.send(buf);
        } catch {
          /* browser gone */
        }
      }
      return new Response('ok');
    }

    if (url.pathname === '/agent-closed' && request.method === 'POST') {
      const { reason } = (await request.json()) as { reason: string };
      const ws = this.browserSocket();
      if (ws) {
        try {
          ws.send(JSON.stringify({ type: 'closed', reason }));
        } catch {
          /* noop */
        }
        this.setOpen(ws, false);
      }
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }

  // ─── Hibernation lifecycle (browser side) ───────────────────────────────

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const att = ws.deserializeAttachment() as BridgeAttachment | undefined;
    if (!att?.open) return;
    try {
      if (typeof message === 'string') {
        await this.handleCtl(att, ws, message);
      } else {
        await agentStub(this.env, att.nodeId)
          .fetch('https://agent.internal/pty-input', {
            method: 'POST',
            body: message,
            headers: { 'content-type': 'application/octet-stream', 'x-omni-pty': att.ptyId },
          })
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.teardown(ws, 'client disconnected');
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.teardown(ws, 'client error');
  }

  // ─── Browser connection setup ───────────────────────────────────────────

  private async handleBrowserWs(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const nodeId = url.searchParams.get('nodeId') ?? '';
    // ptyId doubles as this bridge's DO name so PTY frames route back here
    const ptyId = url.searchParams.get('ptyId') ?? this.state.id.toString();
    const actor = url.searchParams.get('actor') ?? 'anonymous';
    const cols = parseInt(url.searchParams.get('cols') ?? '80', 10) || 80;
    const rows = parseInt(url.searchParams.get('rows') ?? '24', 10) || 24;
    const shell = url.searchParams.get('shell') ?? undefined;

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], ['browser']);
    pair[1].serializeAttachment({ nodeId, ptyId, actor, open: false } satisfies BridgeAttachment);

    // Open the PTY on the agent (retry briefly to ride out agent reconnects)
    let opened = false;
    let lastErr = 'agent offline';
    for (let attempt = 0; attempt < 4 && !opened; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1500));
      }
      try {
        const res = await agentStub(this.env, nodeId).fetch('https://agent.internal/pty-attach', {
          method: 'POST',
          body: JSON.stringify({ ptyId, cols, rows, shell }),
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
      this.setOpen(pair[1], true);
      this.sendCtl(pair[1], { type: 'open', ok: true });
      await this.env.DB.prepare(
        'INSERT INTO terminal_sessions (id, node_id, actor, opened_at) VALUES (?, ?, ?, ?)',
      )
        .bind(ptyId, nodeId, actor, Date.now())
        .run();
      await audit(this.env.DB, {
        actor,
        action: 'terminal.open',
        target: nodeId,
        nodeId,
        ip: clientIp(request),
      });
    } else {
      this.sendCtl(pair[1], { type: 'open', ok: false, reason: lastErr });
      await this.teardown(pair[1], 'agent offline');
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private browserSocket(): WebSocket | null {
    const sockets = this.state.getWebSockets('browser');
    return sockets.length > 0 ? sockets[0] : null;
  }

  private setOpen(ws: WebSocket, open: boolean): void {
    try {
      const att = ws.deserializeAttachment() as BridgeAttachment | undefined;
      if (att) ws.serializeAttachment({ ...att, open });
    } catch {
      /* noop */
    }
  }

  private async handleCtl(att: BridgeAttachment, ws: WebSocket, raw: string): Promise<void> {
    let ctl: { type: string; cols?: number; rows?: number };
    try {
      ctl = JSON.parse(raw);
    } catch {
      return;
    }
    if (ctl.type === 'ping') {
      this.sendCtl(ws, { type: 'pong' });
      return;
    }
    if (ctl.type === 'resize' && ctl.cols && ctl.rows) {
      await agentStub(this.env, att.nodeId)
        .fetch('https://agent.internal/pty-resize', {
          method: 'POST',
          body: JSON.stringify({ ptyId: att.ptyId, cols: ctl.cols, rows: ctl.rows }),
        })
        .catch(() => {});
      return;
    }
    if (ctl.type === 'close') {
      await this.teardown(ws, 'client requested close');
    }
  }

  private sendCtl(ws: WebSocket, ctl: { type: string; ok?: boolean; reason?: string }): void {
    try {
      ws.send(JSON.stringify(ctl));
    } catch {
      /* noop */
    }
  }

  private async teardown(ws: WebSocket, reason: string): Promise<void> {
    const att = (ws.deserializeAttachment() as BridgeAttachment | undefined) ?? null;
    if (!att || (!att.open && !this.browserSocket())) {
      try { ws.close(1000, reason); } catch { /* noop */ }
      return;
    }
    this.setOpen(ws, false);
    try {
      ws.close(1000, reason);
    } catch {
      /* noop */
    }
    if (att.ptyId && att.nodeId) {
      await agentStub(this.env, att.nodeId)
        .fetch('https://agent.internal/pty-close', { method: 'POST', body: JSON.stringify({ ptyId: att.ptyId }) })
        .catch(() => {});
      await closeTerminalSession(this.env.DB, att.ptyId).catch(() => {});
      await audit(this.env.DB, {
        actor: att.actor,
        action: 'terminal.close',
        target: att.nodeId,
        nodeId: att.nodeId,
        detail: reason,
      }).catch(() => {});
    }
  }
}
