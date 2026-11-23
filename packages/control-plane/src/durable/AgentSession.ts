/**
 * AgentSession — WebSocket Hibernation API version.
 * Connection persists at Cloudflare's edge; DO evicted between messages.
 * Duration only accrues during message processing wake-ups.
 */
import { AgentMsg, BinaryKind, envelope, type ExecResultPayload, type ExecStreamPayload, type MetricsPayload, type PtyClosedPayload } from '@omni/shared';
import type { Env } from '../env';
import { logHubStub, schedulerStub, terminalStub, utf8 } from '../util';
import { archiveLog, finishTask, insertMetrics, logKey, markTaskRunning, setNodeStatus, tasksForNodeNeedingFail, touchNode, audit, getNode } from '../db';
import { verifyNodeToken } from '../crypto';
import { pushEvent } from '../events';
import { raiseAlert } from '../webhook';

const HEARTBEAT_STALE_MS = 75_000;
const LOG_ARCHIVE_THRESHOLD = 64_000;
const INLINE_TAIL = 8_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

interface PtyBridge {
  ptyId: string;
  cols: number;
  rows: number;
  shell?: string;
}

export class AgentSession {
  constructor(private state: DurableObjectState, private env: Env) {}

  // ─── Hibernation entry points ──────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const nodeId = await this.state.storage.get<string>("nodeId") ?? "";
    await touchNode(this.env.DB, nodeId);
    if (typeof message === 'string') {
      let msg: { t: string; d?: unknown };
      try { msg = JSON.parse(message); } catch { return; }
      await this.handleAgentMessage(nodeId, msg);
    } else if (message instanceof ArrayBuffer) {
      await this.handleAgentBinary(nodeId, new Uint8Array(message));
    }
  }

  async webSocketClose(_ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    await this.onAgentDisconnected(reason || 'closed', code === 4002);
  }

  // ─── Internal API (called by Worker / other DOs) ───────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/ws') return this.handleAgentWs(request);

    if (path === '/dispatch' && request.method === 'POST') {
      const { message } = (await request.json()) as { message: { t: string; d: unknown } };
      return this.dispatchMessage(message);
    }

    if (path === '/cancel' && request.method === 'POST') {
      const { taskId } = (await request.json()) as { taskId: string };
      this.sendToAgent(envelope(AgentMsg.EXEC_CANCEL, { taskId }));
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }

    if (path === '/pty-attach' && request.method === 'POST') {
      const { ptyId, cols, rows, shell } = (await request.json()) as { ptyId: string; cols: number; rows: number; shell?: string };
      if (!this.getAgentSocket()) return new Response(JSON.stringify({ ok: false, error: 'agent offline' }), { status: 409 });
      const bridges = await this.loadBridges();
      bridges.set(ptyId, { ptyId, cols: cols || 80, rows: rows || 24, shell });
      await this.saveBridges(bridges);
      this.sendToAgent(envelope(AgentMsg.PTY_OPEN, { ptyId, cols: cols || 80, rows: rows || 24, shell }));
      return new Response('ok');
    }

    if (path === '/pty-input' && request.method === 'POST') {
      const buf = new Uint8Array(await request.arrayBuffer());
      const ws = this.getAgentSocket();
      if (ws) {
        const idBytes = utf8(request.headers.get('x-omni-pty') ?? '');
        const frame = new Uint8Array(2 + idBytes.length + buf.length);
        frame[0] = BinaryKind.PTY_DATA;
        frame[1] = idBytes.length;
        frame.set(idBytes, 2);
        frame.set(buf, 2 + idBytes.length);
        ws.send(frame);
      }
      return new Response('ok');
    }

    if (path === '/pty-resize' && request.method === 'POST') {
      const { ptyId, cols, rows } = (await request.json()) as { ptyId: string; cols: number; rows: number };
      this.sendToAgent(envelope(AgentMsg.PTY_RESIZE, { ptyId, cols, rows }));
      return new Response('ok');
    }

    if (path === '/pty-close' && request.method === 'POST') {
      const { ptyId } = (await request.json()) as { ptyId: string };
      const bridges = await this.loadBridges();
      bridges.delete(ptyId);
      await this.saveBridges(bridges);
      this.sendToAgent(envelope(AgentMsg.PTY_CLOSED, { ptyId, reason: 'detached' }));
      return new Response('ok');
    }

    if (path === '/file-upload' && request.method === 'POST') {
      const { path: filePath, dataB64 } = (await request.json()) as { path: string; dataB64: string };
      return this.runFileUpload(filePath, dataB64);
    }

    if (path === '/file-download' && request.method === 'POST') {
      const { path: filePath } = (await request.json()) as { path: string };
      return this.runFileDownload(filePath);
    }

    if (path === '/status' && request.method === 'GET') {
      return new Response(JSON.stringify({ connected: !!this.getAgentSocket() }), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('not found', { status: 404 });
  }

  // ─── WS upgrade ────────────────────────────────────────────────────────

  private async handleAgentWs(request: Request): Promise<Response> {
    const token = new URL(request.url).searchParams.get('token') ?? '';
    const nodeId = await verifyNodeToken(this.env.AUTH_SECRET, token);
    if (!nodeId) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid node token' }), { status: 401 });
    }
    const prev = this.state.getWebSockets('agent');
    for (const old of prev) {
      try { old.close(4002, 'superseded'); } catch { /* already closed */ }
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], ['agent']);
    await this.state.storage.put('nodeId', nodeId);
    await this.state.storage.put('lastSeen', Date.now());
    await this.handleAgentConnected(nodeId);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ─── Agent message handling ────────────────────────────────────────────

  private async handleAgentConnected(nodeId: string): Promise<void> {
    await setNodeStatus(this.env.DB, nodeId, 'online');
    const info = await getNode(this.env.DB, nodeId);
    pushEvent(this.env, { type: 'node_status', data: { nodeId, name: info?.name ?? nodeId, status: 'online' } });
    await audit(this.env.DB, { actor: 'agent', action: 'node.online', target: info?.name ?? nodeId, nodeId });
    await this.state.storage.setAlarm(Date.now() + HEARTBEAT_STALE_MS);
    const bridges = await this.loadBridges();
    for (const [, b] of bridges) {
      this.sendToAgent(envelope(AgentMsg.PTY_OPEN, { ptyId: b.ptyId, cols: b.cols, rows: b.rows, shell: b.shell }));
    }
  }

  private async handleAgentMessage(nodeId: string, msg: { t: string; d?: unknown }): Promise<void> {
    switch (msg.t) {
      case AgentMsg.HEARTBEAT:
        await touchNode(this.env.DB, nodeId);
        break;
      case AgentMsg.METRICS: {
        const m = msg.d as MetricsPayload;
        await touchNode(this.env.DB, nodeId);
        await insertMetrics(this.env.DB, nodeId, {
          cpuPercent: m.cpuPercent, memUsed: m.memUsed, memTotal: m.memTotal,
          diskTotal: m.diskTotal, diskUsed: m.diskUsed,
          diskReadBps: m.diskReadBps ?? null, diskWriteBps: m.diskWriteBps ?? null,
          netInBps: m.netInBps, netOutBps: m.netOutBps,
          load1: m.load1 ?? null, procs: m.procs ?? null, uptimeSec: m.uptimeSec,
        });
        pushEvent(this.env, { type: 'metrics', data: { nodeId, metrics: m } });
        break;
      }
      case AgentMsg.EXEC_STREAM: {
        const s = msg.d as ExecStreamPayload;
        logHubStub(this.env, s.taskId)
          .fetch('https://loghub.internal/stream', { method: 'POST', body: JSON.stringify({ stream: s.stream, dataB64: s.dataB64 }) })
          .catch(() => {});
        break;
      }
      case AgentMsg.EXEC_RESULT: {
        const r = msg.d as ExecResultPayload;
        await this.onExecResult(nodeId, r);
        break;
      }
      case AgentMsg.PTY_CLOSED: {
        const p = msg.d as PtyClosedPayload;
        const bridges = await this.loadBridges();
        bridges.delete(p.ptyId);
        await this.saveBridges(bridges);
        terminalStub(this.env, p.ptyId)
          .fetch('https://terminal.internal/agent-closed', { method: 'POST', body: JSON.stringify({ reason: p.reason ?? 'pty closed' }) })
          .catch(() => {});
        break;
      }
    }
  }

  private async handleAgentBinary(nodeId: string, frame: Uint8Array): Promise<void> {
    if (frame.length < 2) return;
    const kind = frame[0];
    const idLen = frame[1];
    if (frame.length < 2 + idLen) return;
    const channelId = new TextDecoder().decode(frame.subarray(2, 2 + idLen));
    const payload = frame.subarray(2 + idLen);
    if (kind === BinaryKind.PTY_DATA) {
      terminalStub(this.env, channelId)
        .fetch('https://terminal.internal/agent-data', {
          method: 'POST',
          body: payload.slice().buffer as ArrayBuffer,
          headers: { 'content-type': 'application/octet-stream' },
        })
        .catch(() => {});
    }
  }

  // ─── Sending to agent ──────────────────────────────────────────────────

  private getAgentSocket(): WebSocket | null {
    const sockets = this.state.getWebSockets('agent');
    return sockets.length > 0 ? sockets[0] : null;
  }

  private sendToAgent(env: { t: string; d?: unknown; ts?: number }): void {
    const ws = this.getAgentSocket();
    if (ws) {
      try { ws.send(JSON.stringify({ ...env, ts: Date.now() })); } catch { /* closed */ }
    }
  }

  private async dispatchMessage(message: { t: string; d: unknown }): Promise<Response> {
    const ws = this.getAgentSocket();
    if (!ws) return new Response(JSON.stringify({ ok: false, error: 'agent offline' }), { status: 409 });
    if (message.t === AgentMsg.EXEC_REQ) {
      const p = message.d as { taskId: string };
      try {
        ws.send(JSON.stringify({ ...message, ts: Date.now() }));
        await markTaskRunning(this.env.DB, p.taskId);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      } catch {
        return new Response(JSON.stringify({ ok: false, error: 'send failed' }), { status: 409 });
      }
    }
    if (message.t === AgentMsg.EXEC_CANCEL) {
      ws.send(JSON.stringify({ ...message, ts: Date.now() }));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: 'unsupported' }), { status: 400 });
  }

  private async cancelTask(taskId: string): Promise<Response> {
    this.sendToAgent(envelope(AgentMsg.EXEC_CANCEL, { taskId }));
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }

  // ─── Exec result & archiving ───────────────────────────────────────────

  private async onExecResult(nodeId: string, r: ExecResultPayload): Promise<void> {
    const status = r.exitCode === 0 ? 'success' : r.error === 'timeout' ? 'timeout' : 'failed';
    let logPath: string | null = null;
    let logTail: string | null = null;
    let logSize = 0;
    if (r.logB64) {
      const bin = Uint8Array.from(atob(r.logB64), (c) => c.charCodeAt(0));
      logSize = bin.length;
      logTail = new TextDecoder().decode(bin.subarray(-INLINE_TAIL));
      if (logSize > LOG_ARCHIVE_THRESHOLD) {
        logPath = logKey(r.taskId);
        try { await this.env.LOGS.put(logPath, bin); } catch { logPath = null; }
      }
    }
    await finishTask(this.env.DB, r.taskId, { status, exitCode: r.exitCode, error: r.error ?? null, logSize, logTail, logPath });
    logHubStub(this.env, r.taskId)
      .fetch('https://loghub.internal/result', { method: 'POST', body: JSON.stringify({ status, exitCode: r.exitCode, durationMs: r.durationMs, error: r.error }) })
      .catch(() => {});
    schedulerStub(this.env)
      .fetch('https://scheduler.internal/on-task-result', { method: 'POST', body: JSON.stringify({ taskId: r.taskId, status, exitCode: r.exitCode, error: r.error }) })
      .catch(() => {});
    pushEvent(this.env, { type: 'task', data: { taskId: r.taskId, nodeId, status, exitCode: r.exitCode } });
  }

  // ─── File transfer ─────────────────────────────────────────────────────

  private async runFileUpload(filePath: string, dataB64: string): Promise<Response> {
    if (!this.getAgentSocket()) return new Response(JSON.stringify({ ok: false, error: 'agent offline' }), { status: 409 });
    const bin = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
    const tid = `ft_${Date.now()}`;
    this.sendToAgent(envelope(AgentMsg.FILE_TRANSFER_REQ, { transferId: tid, direction: 'upload', path: filePath, size: bin.length }));
    for (let off = 0; off < bin.length; off += 48_000) {
      const ws = this.getAgentSocket();
      if (!ws) break;
      const idBytes = new TextEncoder().encode(tid);
      const frame = new Uint8Array(2 + idBytes.length + Math.min(48_000, bin.length - off));
      frame[0] = 2;
      frame[1] = idBytes.length;
      frame.set(idBytes, 2);
      frame.set(bin.subarray(off, off + 48_000), 2 + idBytes.length);
      ws.send(frame);
    }
    return new Response(JSON.stringify({ ok: true, received: bin.length }), { headers: { 'content-type': 'application/json' } });
  }

  private async runFileDownload(filePath: string): Promise<Response> {
    if (!this.getAgentSocket()) return new Response(JSON.stringify({ ok: false, error: 'agent offline' }), { status: 409 });
    const tid = `ft_${Date.now()}`;
    this.sendToAgent(envelope(AgentMsg.FILE_TRANSFER_REQ, { transferId: tid, direction: 'download', path: filePath, size: 0 }));
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }

  // ─── Disconnect & self-healing ─────────────────────────────────────────

  private async onAgentDisconnected(reason: string, superseded: boolean): Promise<void> {
    const nodeId = await this.state.storage.get<string>('nodeId') ?? '';
    if (!nodeId) return;
    const bridges = await this.loadBridges();
    for (const ptyId of bridges.keys()) {
      terminalStub(this.env, ptyId)
        .fetch('https://terminal.internal/agent-closed', { method: 'POST', body: JSON.stringify({ reason: 'agent offline' }) })
        .catch(() => {});
    }
    await setNodeStatus(this.env.DB, nodeId, 'offline');
    const info = await getNode(this.env.DB, nodeId);
    pushEvent(this.env, { type: 'node_status', data: { nodeId, name: info?.name ?? nodeId, status: 'offline' } });
    await audit(this.env.DB, { actor: 'agent', action: 'node.offline', target: info?.name ?? nodeId, nodeId, detail: reason });
    if (!superseded) {
      await raiseAlert(this.env.DB, this.env.AUTH_SECRET, { level: 'warn', title: `节点离线: ${info?.name ?? nodeId}`, message: `Agent 断开连接 (${reason})`, nodeId });
    }
    const active = await tasksForNodeNeedingFail(this.env.DB, nodeId);
    for (const t of active) {
      await finishTask(this.env.DB, t.id, { status: 'failed', exitCode: null, error: `agent offline: ${reason}` });
      schedulerStub(this.env)
        .fetch('https://scheduler.internal/on-task-result', { method: 'POST', body: JSON.stringify({ taskId: t.id, status: 'failed', exitCode: null, error: 'agent offline' }) })
        .catch(() => {});
    }
  }

  async alarm(): Promise<void> {
    const lastSeen = await this.state.storage.get<number>('lastSeen') ?? 0;
    const nodeId = await this.state.storage.get<string>('nodeId');
    if (nodeId && Date.now() - lastSeen > HEARTBEAT_STALE_MS) {
      await this.onAgentDisconnected('heartbeat timeout', false);
    } else if (nodeId) {
      await this.state.storage.setAlarm(Date.now() + HEARTBEAT_STALE_MS);
    }
  }

  // ─── Storage helpers ───────────────────────────────────────────────────

  private async loadBridges(): Promise<Map<string, { ptyId: string; cols: number; rows: number; shell?: string }>> {
    const data = await this.state.storage.get<string>('bridges');
    if (!data) return new Map();
    return new Map(JSON.parse(data) as [string, { ptyId: string; cols: number; rows: number; shell?: string }][]);
  }

  private async saveBridges(bridges: Map<string, { ptyId: string; cols: number; rows: number; shell?: string }>): Promise<void> {
    await this.state.storage.put('bridges', JSON.stringify([...bridges.entries()]));
  }
}
