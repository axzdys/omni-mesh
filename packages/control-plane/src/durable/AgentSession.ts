/**
 * AgentSession — one Durable Object instance per agent node (name = nodeId).
 * Holds the agent's WebSocket, routes EXEC/PTY/file messages, records
 * metrics, and handles online/offline transitions including webhook alerts.
 */

import { AgentMsg, BinaryKind, decodeBinaryFrame, envelope } from '@omni/shared';
import type { ExecStatus, ExecStreamPayload, ExecResultPayload, MetricsPayload, PtyClosedPayload } from '@omni/shared';
import type { Env } from '../env';
import {
  b64decode,
  b64encode,
  logHubStub,
  schedulerStub,
  terminalStub,
  utf8,
} from '../util';
import {
  archiveLog,
  finishTask,
  insertMetrics,
  logKey,
  markTaskRunning,
  setNodeStatus,
  tasksForNodeNeedingFail,
  touchNode,
  audit,
  getTask,
  getNode,
} from '../db';
import { verifyNodeToken } from '../crypto';
import { pushEvent } from '../events';
import { raiseAlert } from '../webhook';

const HEARTBEAT_STALE_MS = 75_000;
const LOG_ARCHIVE_THRESHOLD = 64_000; // bytes — above this, full log goes to R2
const LOG_MEMORY_CAP = 10_000_000; // stop buffering beyond 10MB
const INLINE_TAIL = 8_000;

interface PtyBridge {
  ptyId: string;
  cols: number;
  rows: number;
  shell?: string;
}

interface PendingFileUpload {
  resolve: (r: { ok: boolean; received: number; error?: string }) => void;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingFileDownload {
  chunks: Uint8Array[];
  bytes: number;
  resolve: (r: { ok: boolean; dataB64?: string; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AgentSession {
  private agentWs: WebSocket | null = null;
  private nodeId: string | null = null;
  private wasOnline = false;
  private lastSeen = 0;
  private bridges = new Map<string, PtyBridge>(); // ptyId -> bridge info (ptyId doubles as bridge DO name)
  private taskLogs = new Map<string, { parts: string[]; bytes: number; truncated: boolean; chunks: number }>();
  private fileUploads = new Map<string, PendingFileUpload>();
  private cancelledTasks = new Set<string>();
  private fileDownloads = new Map<string, PendingFileDownload>();

  constructor(private state: DurableObjectState, private env: Env) {
    this.state.blockConcurrencyWhile(async () => {});
  }

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
      return this.cancelTask(taskId);
    }

    if (path === '/pty-attach' && request.method === 'POST') {
      const { ptyId, cols, rows, shell } = (await request.json()) as {
        ptyId: string;
        cols: number;
        rows: number;
        shell?: string;
      };
      if (!this.agentWs) {
        
        return new Response(JSON.stringify({ ok: false, error: 'agent offline' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      
      this.bridges.set(ptyId, { ptyId, cols: cols || 80, rows: rows || 24, shell });
      // request the agent to spawn the shell
      this.sendJson(AgentMsg.PTY_OPEN, { ptyId, cols: cols || 80, rows: rows || 24, shell });
      return new Response('ok');
    }

    if (path === '/pty-input' && request.method === 'POST') {
      const buf = new Uint8Array(await request.arrayBuffer());
      
      const sent = this.sendBinary(BinaryKind.PTY_DATA, request.headers.get('x-omni-pty') ?? '', buf);
      
      return new Response('ok');
    }

    if (path === '/pty-resize' && request.method === 'POST') {
      const { ptyId, cols, rows } = (await request.json()) as { ptyId: string; cols: number; rows: number };
      this.sendJson(AgentMsg.PTY_RESIZE, { ptyId, cols, rows });
      return new Response('ok');
    }

    if (path === '/pty-close' && request.method === 'POST') {
      const { ptyId } = (await request.json()) as { ptyId: string };
      this.bridges.delete(ptyId);
      this.sendJson(AgentMsg.PTY_CLOSED, { ptyId, reason: 'detached' });
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
      return new Response(JSON.stringify({ connected: this.agentWs !== null, nodeId: this.nodeId }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }

  // ─── Agent websocket lifecycle ────────────────────────────────────────

  private async handleAgentWs(request: Request): Promise<Response> {
    const token = new URL(request.url).searchParams.get('token') ?? '';
    const nodeId = await verifyNodeToken(this.env.AUTH_SECRET, token);
    if (!nodeId) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid node token' }), { status: 401 });
    }
    // adopt this socket; kick any previous agent connection
    if (this.agentWs) {
      try {
        this.agentWs.close(4002, 'superseded by a newer session');
      } catch {
        /* already closing */
      }
    }
    this.nodeId = nodeId;
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    this.agentWs = server;
    this.lastSeen = Date.now();

    server.addEventListener('message', (ev: MessageEvent) => {
      try {
        if (typeof ev.data === 'string') {
          // message handlers touch D1 which can transiently throw SQLITE_BUSY
          // under local-dev concurrency — swallow rejections so a failed write
          // never crashes the DO (which would drop the socket)
          void this.handleAgentMessage(ev.data).catch((e) =>
            console.error('[agent-session] message handling rejected:', e instanceof Error ? e.message : e),
          );
        } else if (ev.data instanceof ArrayBuffer) {
          void this.handleAgentBinary(new Uint8Array(ev.data));
        }
      } catch (e) {
        console.error('agent message handler error', e);
      }
    });

    server.addEventListener('close', (ev: CloseEvent) => {
      if (this.agentWs !== server) return; // stale socket already replaced
      this.agentWs = null;
      void this.onAgentDisconnected(ev.reason || 'closed', ev.code === 4002);
    });

    server.addEventListener('error', () => {
      if (this.agentWs !== server) return;
      this.agentWs = null;
      void this.onAgentDisconnected('connection error', false);
    });

    // AUTH_OK is sent after the agent's AUTH message arrives; see handleAgentMessage
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private sendJson(t: (typeof AgentMsg)[keyof typeof AgentMsg], d?: unknown): boolean {
    const ws = this.agentWs;
    if (!ws) return false;
    try {
      ws.send(JSON.stringify(envelope(t, d)));
      return true;
    } catch {
      return false;
    }
  }

  private sendBinary(kind: number, channelId: string, payload: Uint8Array): boolean {
    const ws = this.agentWs;
    if (!ws) return false;
    try {
      const idBytes = utf8(channelId);
      const frame = new Uint8Array(2 + idBytes.length + payload.length);
      frame[0] = kind;
      frame[1] = idBytes.length;
      frame.set(idBytes, 2);
      frame.set(payload, 2 + idBytes.length);
      ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  private async handleAgentMessage(raw: string): Promise<void> {
    let msg: { t: string; id?: string; d?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    this.lastSeen = Date.now();
    switch (msg.t) {
      case AgentMsg.AUTH: {
        const d = msg.d as { token?: string; version?: string };
        const nodeId = d?.token ? await verifyNodeToken(this.env.AUTH_SECRET, d.token) : null;
        if (!nodeId || nodeId !== this.nodeId) {
          this.sendJson(AgentMsg.AUTH_ERR, { error: 'invalid token' });
          try {
            this.agentWs?.close(4001, 'auth failed');
          } catch {
            /* noop */
          }
          return;
        }
        this.sendJson(AgentMsg.AUTH_OK, { nodeId, heartbeatSec: 15, metricsSec: 30 });
        await this.onAgentConnected();
        break;
      }
      case AgentMsg.HEARTBEAT: {
        await touchNode(this.env.DB, this.nodeId!);
        break;
      }
      case AgentMsg.METRICS: {
        const m = msg.d as MetricsPayload;
        await touchNode(this.env.DB, this.nodeId!);
        await insertMetrics(this.env.DB, this.nodeId!, {
          cpuPercent: m.cpuPercent,
          memUsed: m.memUsed,
          memTotal: m.memTotal,
          diskTotal: m.diskTotal,
          diskUsed: m.diskUsed,
          diskReadBps: m.diskReadBps ?? null,
          diskWriteBps: m.diskWriteBps ?? null,
          netInBps: m.netInBps,
          netOutBps: m.netOutBps,
          load1: m.load1 ?? null,
          procs: m.procs ?? null,
          uptimeSec: m.uptimeSec,
        });
        pushEvent(this.env, { type: 'metrics', data: { nodeId: this.nodeId!, metrics: m } });
        break;
      }
      case AgentMsg.EXEC_STREAM: {
        const s = msg.d as ExecStreamPayload;
        await this.onExecStream(s.taskId, s.stream, s.dataB64);
        break;
      }
      case AgentMsg.EXEC_RESULT: {
        const r = msg.d as ExecResultPayload;
        await this.onExecResult(r);
        break;
      }
      case AgentMsg.PTY_CLOSED: {
        const p = msg.d as PtyClosedPayload;
        const bridgeId = p.ptyId;
        this.bridges.delete(bridgeId);
        if (bridgeId) {
          terminalStub(this.env, bridgeId)
            .fetch('https://terminal.internal/agent-closed', {
              method: 'POST',
              body: JSON.stringify({ reason: p.reason ?? 'pty closed' }),
            })
            .catch(() => {});
        }
        break;
      }
      case AgentMsg.FILE_TRANSFER_ACK: {
        const ack = msg.d as { transferId: string; received: number; done: boolean; error?: string };
        const up = this.fileUploads.get(ack.transferId);
        if (up) {
          clearTimeout(up.timer);
          this.fileUploads.delete(ack.transferId);
          up.resolve({ ok: !ack.error, received: ack.received, error: ack.error });
        }
        const down = this.fileDownloads.get(ack.transferId);
        if (down && (ack.done || ack.error)) {
          clearTimeout(down.timer);
          this.fileDownloads.delete(ack.transferId);
          const total = new Uint8Array(down.bytes);
          let off = 0;
          for (const c of down.chunks) {
            total.set(c, off);
            off += c.length;
          }
          down.resolve({ ok: !ack.error, dataB64: ack.error ? undefined : b64encode(total), error: ack.error });
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleAgentBinary(frame: Uint8Array): Promise<void> {
    if (frame.length < 2) return;
    const kind = frame[0];
    const idLen = frame[1];
    if (frame.length < 2 + idLen) return;
    const channelId = new TextDecoder().decode(frame.subarray(2, 2 + idLen));
    const payload = frame.subarray(2 + idLen);

    if (kind === BinaryKind.PTY_DATA) {
      const bridge = this.bridges.get(channelId);
      if (!bridge) {
        
        return;
      }
      terminalStub(this.env, channelId)
        .fetch('https://terminal.internal/agent-data', {
          method: 'POST',
          body: payload.slice().buffer as ArrayBuffer,
          headers: { 'content-type': 'application/octet-stream' },
        })
        .catch(() => {});
    } else if (kind === BinaryKind.FILE_CHUNK) {
      const down = this.fileDownloads.get(channelId);
      if (down) {
        down.chunks.push(payload.slice());
        down.bytes += payload.length;
      }
    }
  }

  // ─── Online/offline transitions ───────────────────────────────────────

  private async onAgentConnected(): Promise<void> {
    const firstConnect = !this.wasOnline;
    this.wasOnline = true;
    const db = this.env.DB;
    await setNodeStatus(db, this.nodeId!, 'online');
    const info = await getNode(db, this.nodeId!);
    pushEvent(this.env, { type: 'node_status', data: { nodeId: this.nodeId!, name: info?.name ?? this.nodeId!, status: 'online' } });
    await audit(db, { actor: 'agent', action: 'node.online', target: info?.name ?? this.nodeId!, nodeId: this.nodeId });
    // heartbeat watchdog
    await this.state.storage.setAlarm(Date.now() + HEARTBEAT_STALE_MS);

    // Self-healing: after an agent reconnect, re-spawn every PTY that had a
    // live browser bridge so WebSSH sessions survive agent restarts.
    if (!firstConnect && this.bridges.size > 0) {
      for (const [ptyId, b] of this.bridges) {
        
        this.sendJson(AgentMsg.PTY_OPEN, { ptyId, cols: b.cols, rows: b.rows, shell: b.shell });
      }
    }
  }

  private async onAgentDisconnected(reason: string, superseded: boolean): Promise<void> {
    this.wasOnline = false;
    const nodeId = this.nodeId;
    if (!nodeId) return;
    // tear down live PTY bridges
    for (const ptyId of [...this.bridges.keys()]) {
      this.bridges.delete(ptyId);
      terminalStub(this.env, ptyId)
        .fetch('https://terminal.internal/agent-closed', { method: 'POST', body: JSON.stringify({ reason: 'agent offline' }) })
        .catch(() => {});
    }
    // fail in-flight tasks
    const active = await tasksForNodeNeedingFail(this.env.DB, nodeId);
    for (const t of active) {
      await finishTask(this.env.DB, t.id, { status: 'failed', exitCode: null, error: `agent offline: ${reason}` });
      logHubStub(this.env, t.id)
        .fetch('https://loghub.internal/result', {
          method: 'POST',
          body: JSON.stringify({ status: 'failed', exitCode: null, durationMs: 0, error: 'agent offline' }),
        })
        .catch(() => {});
      schedulerStub(this.env)
        .fetch('https://scheduler.internal/on-task-result', {
          method: 'POST',
          body: JSON.stringify({ taskId: t.id, status: 'failed', exitCode: null, error: 'agent offline' }),
        })
        .catch(() => {});
    }
    await setNodeStatus(this.env.DB, nodeId, 'offline');
    const nodeInfo = await getNode(this.env.DB, nodeId);
    const nodeName = nodeInfo?.name ?? nodeId;
    pushEvent(this.env, { type: 'node_status', data: { nodeId, name: nodeName, status: 'offline' } });
    await audit(this.env.DB, { actor: 'agent', action: 'node.offline', target: nodeName, nodeId, detail: reason });
    if (!superseded) {
      await raiseAlert(this.env.DB, this.env.AUTH_SECRET, {
        level: 'warn',
        title: `节点离线: ${nodeName}`,
        message: `Agent 断开连接 (${reason})`,
        nodeId,
      });
    }
    await this.state.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    if (this.agentWs && this.wasOnline) {
      if (Date.now() - this.lastSeen > HEARTBEAT_STALE_MS) {
        try {
          this.agentWs.close(4001, 'heartbeat timeout');
        } catch {
          /* noop */
        }
        this.agentWs = null;
        await this.onAgentDisconnected('heartbeat timeout', false);
      } else {
        await this.state.storage.setAlarm(Date.now() + HEARTBEAT_STALE_MS);
      }
    }
  }

  // ─── Dispatch / cancel ────────────────────────────────────────────────

  private async dispatchMessage(message: { t: string; d: unknown }): Promise<Response> {
    if (!this.agentWs) {
      return new Response(JSON.stringify({ ok: false, error: 'agent not connected' }), { status: 409 });
    }
    if (message.t === AgentMsg.EXEC_REQ) {
      const p = message.d as { taskId: string };
      const sent = this.sendJson(AgentMsg.EXEC_REQ, message.d);
      if (sent) await markTaskRunning(this.env.DB, p.taskId);
      return new Response(JSON.stringify({ ok: sent }), { status: sent ? 200 : 409 });
    }
    return new Response(JSON.stringify({ ok: false, error: 'unsupported dispatch type' }), { status: 400 });
  }

  private async cancelTask(taskId: string): Promise<Response> {
    const sent = this.sendJson(AgentMsg.EXEC_CANCEL, { taskId });
    // remember so the eventual EXEC_RESULT maps to "cancelled" instead of "failed"
    if (sent) this.cancelledTasks.add(taskId);
    return new Response(JSON.stringify({ ok: true, cancelSent: sent }), { headers: { 'content-type': 'application/json' } });
  }

  // ─── Exec streaming & persistence ─────────────────────────────────────

  private async onExecStream(taskId: string, stream: 'out' | 'err', dataB64: string): Promise<void> {
    let buf = this.taskLogs.get(taskId);
    if (!buf) {
      buf = { parts: [], bytes: 0, truncated: false, chunks: 0 };
      this.taskLogs.set(taskId, buf);
    }
    const raw = b64decode(dataB64);
    buf.chunks++;
    if (buf.bytes + raw.length <= LOG_MEMORY_CAP) {
      buf.parts.push(new TextDecoder().decode(raw));
      buf.bytes += raw.length;
    } else {
      buf.truncated = true;
    }
    logHubStub(this.env, taskId)
      .fetch('https://loghub.internal/stream', {
        method: 'POST',
        body: JSON.stringify({ stream, dataB64 }),
      })
      .catch(() => {});
  }

  private async onExecResult(r: ExecResultPayload): Promise<void> {
    const buf = this.taskLogs.get(r.taskId);
    this.taskLogs.delete(r.taskId);
    const logText = buf ? buf.parts.join('') + (buf.truncated ? '\n[omni] output truncated at 10MB\n' : '') : '';
    let status: ExecStatus =
      r.exitCode === 0 ? 'success' : r.error === 'timeout' ? 'timeout' : r.exitCode === null && r.error ? 'failed' : 'failed';
    if (this.cancelledTasks.delete(r.taskId)) {
      status = 'cancelled';
    }

    let logPath: string | null = null;
    let logTail: string | null = logText || null;
    let logSize = buf ? buf.bytes : 0;
    let archiveError: string | null = null;
    if (logText.length > LOG_ARCHIVE_THRESHOLD) {
      logPath = logKey(r.taskId);
      try {
        logSize = await archiveLog(this.env.LOGS, logPath, logText);
        logTail = logText.slice(-INLINE_TAIL);
      } catch (e) {
        // surfaces on the task row so archive failures are observable even
        // when the DO console is not reachable
        archiveError = 'r2-archive: ' + (e instanceof Error ? e.message : String(e));
        logPath = null;
      }
    }

    const errorText = (r.error && r.error !== 'timeout' ? r.error : null) ?? archiveError;
    await finishTask(this.env.DB, r.taskId, {
      status,
      exitCode: r.exitCode,
      error: errorText,
      logSize,
      logTail,
      logPath,
    });

    logHubStub(this.env, r.taskId)
      .fetch('https://loghub.internal/result', {
        method: 'POST',
        body: JSON.stringify({ status, exitCode: r.exitCode, durationMs: r.durationMs, error: errorText }),
      })
      .catch(() => {});

    schedulerStub(this.env)
      .fetch('https://scheduler.internal/on-task-result', {
        method: 'POST',
        body: JSON.stringify({ taskId: r.taskId, status, exitCode: r.exitCode, error: errorText }),
      })
      .catch(() => {});

    const task = await getTask(this.env.DB, r.taskId);
    pushEvent(this.env, {
      type: 'task',
      data: { taskId: r.taskId, nodeId: task?.node_id ?? '', status, exitCode: r.exitCode },
    });
  }

  // ─── File transfer ────────────────────────────────────────────────────

  private async runFileUpload(filePath: string, dataB64: string): Promise<Response> {
    if (!this.agentWs) {
      return new Response(JSON.stringify({ ok: false, error: 'agent not connected' }), { status: 409 });
    }
    const data = b64decode(dataB64);
    const transferId = `ft_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const CH = 48_000;
    this.sendJson(AgentMsg.FILE_TRANSFER_REQ, { transferId, direction: 'upload', path: filePath, size: data.length });
    for (let off = 0; off < data.length; off += CH) {
      this.sendBinary(BinaryKind.FILE_CHUNK, transferId, data.subarray(off, off + CH));
    }
    const result = await new Promise<{ ok: boolean; received: number; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.fileUploads.delete(transferId);
        resolve({ ok: false, received: 0, error: 'upload timed out' });
      }, 30_000);
      this.fileUploads.set(transferId, { resolve, bytes: data.length, timer });
    });
    await audit(this.env.DB, {
      actor: 'dashboard',
      action: 'file.upload',
      target: filePath,
      nodeId: this.nodeId,
      detail: `${data.length} bytes`,
    });
    return new Response(JSON.stringify(result), { status: result.ok ? 200 : 500, headers: { 'content-type': 'application/json' } });
  }

  private async runFileDownload(filePath: string): Promise<Response> {
    if (!this.agentWs) {
      return new Response(JSON.stringify({ ok: false, error: 'agent not connected' }), { status: 409 });
    }
    const transferId = `ft_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.sendJson(AgentMsg.FILE_TRANSFER_REQ, { transferId, direction: 'download', path: filePath, size: 0 });
    const result = await new Promise<{ ok: boolean; dataB64?: string; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.fileDownloads.delete(transferId);
        resolve({ ok: false, error: 'download timed out' });
      }, 30_000);
      this.fileDownloads.set(transferId, { chunks: [], bytes: 0, resolve, timer });
    });
    await audit(this.env.DB, {
      actor: 'dashboard',
      action: 'file.download',
      target: filePath,
      nodeId: this.nodeId,
    });
    return new Response(JSON.stringify(result), { status: result.ok ? 200 : 500, headers: { 'content-type': 'application/json' } });
  }
}
