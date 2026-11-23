/**
 * OmniMesh shared protocol — the single source of truth for all
 * Agent <-> Control-Plane and Control-Plane <-> Dashboard communication.
 *
 * ─── Transport overview ────────────────────────────────────────────────
 * 1. JSON control messages  → WS **text** frames:  { "t": "<type>", "id"?: string, "ts": number, "d"?: any }
 * 2. Binary stream messages → WS **binary** frames (low-latency PTY data
 *    and file chunks bypass JSON parsing):
 *
 *        byte 0      kind        (0x01 = PTY data, 0x02 = file chunk)
 *        byte 1      idLen       (channel id length in bytes)
 *        bytes 2..N  channelId   (utf-8, e.g. "pty_abc123" / "ft_abc123")
 *        bytes N..   payload     (raw bytes)
 *
 * All timestamps are unix milliseconds (UTC).
 */

// ─── Agent ⇄ Control-Plane message types (JSON envelopes) ────────────────

export const AgentMsg = {
  AUTH: 'AUTH',
  AUTH_OK: 'AUTH_OK',
  AUTH_ERR: 'AUTH_ERR',
  HEARTBEAT: 'HEARTBEAT',
  METRICS: 'METRICS',
  EXEC_REQ: 'EXEC_REQ',
  EXEC_STREAM: 'EXEC_STREAM',
  EXEC_RESULT: 'EXEC_RESULT',
  EXEC_CANCEL: 'EXEC_CANCEL',
  PTY_OPEN: 'PTY_OPEN',
  PTY_CLOSED: 'PTY_CLOSED',
  PTY_RESIZE: 'PTY_RESIZE',
  FILE_TRANSFER_REQ: 'FILE_TRANSFER_REQ',
  FILE_TRANSFER_ACK: 'FILE_TRANSFER_ACK',
} as const;
export type AgentMsgType = (typeof AgentMsg)[keyof typeof AgentMsg];

/** Binary frame kind byte (see header comment). */
export const BinaryKind = { PTY_DATA: 0x01, FILE_CHUNK: 0x02 } as const;

export const EXEC_STATUS = ['queued', 'running', 'success', 'failed', 'timeout', 'cancelled'] as const;
export type ExecStatus = (typeof EXEC_STATUS)[number];

// ─── Payload definitions ────────────────────────────────────────────────

export interface AuthPayload {
  token: string;
  version: string;
}

export interface AuthOkPayload {
  nodeId: string;
  heartbeatSec: number;
  metricsSec: number;
}

export interface HeartbeatPayload {
  uptimeSec: number;
}

export interface MetricsPayload {
  cpuPercent: number; // 0-100
  memUsed: number; // bytes
  memTotal: number; // bytes
  diskTotal: number; // bytes (root/filesystem of install)
  diskUsed: number; // bytes
  diskReadBps: number | null; // bytes/sec (null = unsupported on platform)
  diskWriteBps: number | null;
  netInBps: number; // bytes/sec
  netOutBps: number;
  load1: number | null;
  procs: number | null;
  uptimeSec: number;
  bootTs: number | null;
}

export type ExecLang = 'shell' | 'python';

export interface ExecReqPayload {
  taskId: string;
  script: string;
  lang?: ExecLang;
  workDir?: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

export interface ExecStreamPayload {
  taskId: string;
  stream: 'out' | 'err';
  dataB64: string;
}

export interface ExecResultPayload {
  taskId: string;
  exitCode: number | null; // null = killed / spawn error
  signal?: string | null;
  durationMs: number;
  error?: string;
  logB64?: string; // full accumulated stdout+stderr (base64) for archiving
}

export interface ExecCancelPayload {
  taskId: string;
}

export interface PtyOpenPayload {
  ptyId: string;
  cols: number;
  rows: number;
  shell?: string;
}

export interface PtyResizePayload {
  ptyId: string;
  cols: number;
  rows: number;
}

export interface PtyClosedPayload {
  ptyId: string;
  reason?: string;
}

export type FileDirection = 'upload' | 'download';

export interface FileTransferReqPayload {
  transferId: string;
  direction: FileDirection;
  path: string; // absolute path on the agent
  size: number; // upload: total expected bytes; download: 0 (agent decides)
}

export interface FileTransferAckPayload {
  transferId: string;
  received: number; // upload: bytes written so far; download: bytes sent so far
  done: boolean;
  error?: string;
}

// ─── JSON envelope helper ────────────────────────────────────────────────

export interface Envelope<T = unknown> {
  t: AgentMsgType;
  id?: string;
  ts: number;
  d?: T;
}

export function envelope<T>(t: AgentMsgType, d?: T, id?: string): Envelope<T> {
  return { t, id, ts: Date.now(), d };
}

// ─── Binary frame codec (shared by TS control-plane/dashboard and Go agent) ──

export function encodeBinaryFrame(kind: number, channelId: string, payload: Uint8Array): Uint8Array {
  const idBytes = new TextEncoder().encode(channelId);
  if (idBytes.length > 255) throw new Error('channel id too long');
  const out = new Uint8Array(2 + idBytes.length + payload.length);
  out[0] = kind;
  out[1] = idBytes.length;
  out.set(idBytes, 2);
  out.set(payload, 2 + idBytes.length);
  return out;
}

export function decodeBinaryFrame(data: Uint8Array): { kind: number; channelId: string; payload: Uint8Array } | null {
  if (data.length < 2) return null;
  const kind = data[0];
  const idLen = data[1];
  if (data.length < 2 + idLen) return null;
  const channelId = new TextDecoder().decode(data.subarray(2, 2 + idLen));
  const payload = data.subarray(2 + idLen).slice();
  return { kind, channelId, payload };
}

// ─── Dashboard ⇄ Control-Plane WS events (/api/ws/events) ────────────────

export type DashEvent =
  | { type: 'hello'; data: { ts: number } }
  | { type: 'node_status'; data: { nodeId: string; name: string; status: 'online' | 'offline'; labels?: string[] } }
  | { type: 'metrics'; data: { nodeId: string; metrics: MetricsPayload } }
  | { type: 'task'; data: { taskId: string; nodeId: string; status: ExecStatus; exitCode?: number | null } }
  | { type: 'run'; data: { runId: string; defId: string; status: string } }
  | { type: 'alert'; data: { level: string; title: string; message: string; nodeId?: string } };

// ─── Terminal WS ctl frames (/api/ws/terminal/:nodeId, JSON text frames) ──

export type TerminalCtlUp =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }
  | { type: 'close' };

export type TerminalCtlDown =
  | { type: 'open'; ok: boolean; reason?: string }
  | { type: 'closed'; reason?: string }
  | { type: 'pong' };

// ─── Task WS frames (/api/ws/task/:taskId, JSON text frames) ─────────────

export type TaskWsDown =
  | { type: 'tail'; data: string }
  | { type: 'stream'; stream: 'out' | 'err'; dataB64: string }
  | { type: 'result'; status: ExecStatus; exitCode: number | null; durationMs: number; error?: string };

// ─── REST API shared models (dashboard typing) ───────────────────────────

export interface NodeInfo {
  id: string;
  name: string;
  labels: string[];
  status: 'online' | 'offline';
  os: string;
  arch: string;
  version: string;
  ip: string;
  hostname: string;
  lastSeen: number | null;
  createdAt: number;
}

export interface ExecTask {
  id: string;
  kind: 'manual' | 'cron' | 'workflow';
  refId: string | null;
  nodeId: string;
  nodeName?: string;
  script: string;
  lang: ExecLang;
  status: ExecStatus;
  exitCode: number | null;
  timeoutMs: number;
  attempts: number;
  logSize: number;
  logTail: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface CronJob {
  id: string;
  name: string;
  expr: string;
  targetType: 'node' | 'tag' | 'all';
  targetValue: string | null;
  script: string;
  lang: ExecLang;
  timeoutMs: number;
  retries: number;
  envKeys: string[]; // decrypted values never leave the server
  enabled: boolean;
  nextRun: number | null;
  lastRun: number | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkflowStepType = 'script' | 'webhook';

export interface WorkflowStepData {
  label: string;
  type: WorkflowStepType;
  // script node
  targetType?: 'node' | 'tag' | 'all';
  targetValue?: string | null;
  script?: string;
  lang?: ExecLang;
  timeoutMs?: number;
  retries?: number;
  env?: Record<string, string>;
  onFailure?: 'stop' | 'continue';
  // webhook node
  url?: string;
  method?: 'GET' | 'POST' | 'PUT';
  body?: string;
}

export interface WorkflowGraph {
  nodes: { id: string; position: { x: number; y: number }; data: WorkflowStepData }[];
  edges: { id: string; source: string; target: string }[];
}

export interface WorkflowDef {
  id: string;
  name: string;
  graph: WorkflowGraph;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type RunStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'timeout' | 'skipped' | 'cancelled';

export interface RunStep {
  stepId: string;
  runId: string;
  label: string;
  type: WorkflowStepType;
  status: RunStepStatus;
  taskIds: string[];
  exitCode: number | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowRun {
  id: string;
  defId: string;
  defName: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  steps: RunStep[];
  createdAt: number;
  finishedAt: number | null;
}

export interface AuditEntry {
  id: string;
  ts: number;
  actor: string;
  action: string;
  target: string;
  nodeId: string | null;
  detail: string | null;
  ip: string | null;
}

export interface RegKey {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface AlertEntry {
  id: string;
  ts: number;
  level: 'info' | 'warn' | 'error';
  title: string;
  message: string;
  nodeId: string | null;
  notified: boolean;
}

/** Aggregated metric point returned by /api/metrics/:nodeId */
export interface MetricsPoint {
  ts: number;
  cpu: number | null;
  memUsed: number | null;
  memTotal: number | null;
  diskReadBps: number | null;
  diskWriteBps: number | null;
  netInBps: number | null;
  netOutBps: number | null;
  load1: number | null;
}
