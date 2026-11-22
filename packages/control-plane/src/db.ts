/**
 * D1 repository layer. All SQL lives here; every function takes the binding
 * (or a compatible stand-in in tests) so the layer is unit-testable.
 */

import { b64decode, b64encode, parseJson } from './util';
import { aesDecrypt, aesEncrypt } from './crypto';
import type { ExecStatus, NodeInfo, ExecLang } from '@omni/shared';

export interface DB {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export function rows<T>(res: D1Result<Record<string, unknown>>): T[] {
  return (res.results ?? []) as unknown as T[];
}

// ─── Node row mapping ────────────────────────────────────────────────────

interface NodeRow {
  id: string;
  name: string;
  labels: string;
  status: string;
  os: string;
  arch: string;
  version: string;
  ip: string;
  hostname: string;
  last_seen: number | null;
  created_at: number;
}

export function mapNode(r: NodeRow): NodeInfo {
  return {
    id: r.id,
    name: r.name,
    labels: parseJson<string[]>(r.labels, []),
    status: r.status as NodeInfo['status'],
    os: r.os,
    arch: r.arch,
    version: r.version,
    ip: r.ip,
    hostname: r.hostname,
    lastSeen: r.last_seen,
    createdAt: r.created_at,
  };
}

// ─── Nodes ───────────────────────────────────────────────────────────────

export async function listNodes(db: DB): Promise<NodeInfo[]> {
  const res = await db.prepare('SELECT * FROM nodes ORDER BY status DESC, name ASC').all();
  return rows<NodeRow>(res).map(mapNode);
}

export async function getNode(db: DB, nodeId: string): Promise<NodeInfo | null> {
  const res = await db.prepare('SELECT * FROM nodes WHERE id = ?').bind(nodeId).all();
  const r = rows<NodeRow>(res)[0];
  return r ? mapNode(r) : null;
}

export async function upsertNode(
  db: DB,
  nodeId: string,
  patch: { name: string; labels: string[]; os?: string; arch?: string; version?: string; ip?: string; hostname?: string },
): Promise<void> {
  const existing = await getNode(db, nodeId);
  if (existing) {
    await db
      .prepare(
        `UPDATE nodes SET name = ?, labels = ?, os = COALESCE(?, os), arch = COALESCE(?, arch),
         version = COALESCE(?, version), ip = COALESCE(?, ip), hostname = COALESCE(?, hostname)
         WHERE id = ?`,
      )
      .bind(
        patch.name,
        JSON.stringify(patch.labels),
        patch.os ?? null,
        patch.arch ?? null,
        patch.version ?? null,
        patch.ip ?? null,
        patch.hostname ?? null,
        nodeId,
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO nodes (id, name, labels, status, os, arch, version, ip, hostname, created_at)
         VALUES (?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        nodeId,
        patch.name,
        JSON.stringify(patch.labels),
        patch.os ?? '',
        patch.arch ?? '',
        patch.version ?? '',
        patch.ip ?? '',
        patch.hostname ?? '',
        Date.now(),
      )
      .run();
  }
}

export async function setNodeStatus(db: DB, nodeId: string, status: 'online' | 'offline'): Promise<void> {
  await db.prepare('UPDATE nodes SET status = ?, last_seen = ? WHERE id = ?').bind(status, Date.now(), nodeId).run();
}

export async function touchNode(db: DB, nodeId: string): Promise<void> {
  await db.prepare('UPDATE nodes SET last_seen = ? WHERE id = ?').bind(Date.now(), nodeId).run();
}

export async function deleteNode(db: DB, nodeId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM nodes WHERE id = ?').bind(nodeId),
    db.prepare('DELETE FROM metrics WHERE node_id = ?').bind(nodeId),
  ]);
}

export async function nodesMatchingTarget(
  db: DB,
  targetType: 'node' | 'tag' | 'all',
  targetValue: string | null,
): Promise<NodeInfo[]> {
  const all = await listNodes(db);
  if (targetType === 'all') return all.filter((n) => n.status === 'online');
  if (targetType === 'node') return all.filter((n) => n.id === targetValue);
  return all.filter((n) => n.status === 'online' && n.labels.includes(targetValue ?? ''));
}

// ─── Metrics ─────────────────────────────────────────────────────────────

export interface MetricsRow {
  node_id: string;
  ts: number;
  cpu: number | null;
  mem_used: number | null;
  mem_total: number | null;
  disk_total: number | null;
  disk_used: number | null;
  disk_read_bps: number | null;
  disk_write_bps: number | null;
  net_in_bps: number | null;
  net_out_bps: number | null;
  load1: number | null;
  procs: number | null;
  uptime: number | null;
}

export async function insertMetrics(db: DB, nodeId: string, m: {
  cpuPercent: number;
  memUsed: number;
  memTotal: number;
  diskTotal: number;
  diskUsed: number;
  diskReadBps: number | null;
  diskWriteBps: number | null;
  netInBps: number;
  netOutBps: number;
  load1: number | null;
  procs: number | null;
  uptimeSec: number;
}): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO metrics (node_id, ts, cpu, mem_used, mem_total, disk_total, disk_used,
       disk_read_bps, disk_write_bps, net_in_bps, net_out_bps, load1, procs, uptime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      nodeId,
      Date.now(),
      m.cpuPercent,
      m.memUsed,
      m.memTotal,
      m.diskTotal,
      m.diskUsed,
      m.diskReadBps,
      m.diskWriteBps,
      m.netInBps,
      m.netOutBps,
      m.load1,
      m.procs,
      m.uptimeSec,
    )
    .run();
}

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

export type MetricsRange = '1h' | '24h' | '7d';

const RANGE_MS: Record<MetricsRange, number> = { '1h': 3600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 };

export async function queryMetrics(db: DB, nodeId: string, range: MetricsRange): Promise<MetricsPoint[]> {
  const span = RANGE_MS[range] ?? RANGE_MS['1h'];
  const since = Date.now() - span;
  // Bucket size (ms): 1h -> 30s, 24h -> 5m, 7d -> 1h. `ts` column is milliseconds.
  const bucket = range === '1h' ? 30_000 : range === '24h' ? 300_000 : 3_600_000;
  const res = await db
    .prepare(
      `SELECT (ts / ${bucket}) * ${bucket} AS b, AVG(cpu) AS cpu, AVG(mem_used) AS mem_used,
              AVG(mem_total) AS mem_total, AVG(disk_read_bps) AS disk_read_bps,
              AVG(disk_write_bps) AS disk_write_bps, AVG(net_in_bps) AS net_in_bps,
              AVG(net_out_bps) AS net_out_bps, AVG(load1) AS load1
       FROM metrics WHERE node_id = ? AND ts >= ?
       GROUP BY b ORDER BY b ASC`,
    )
    .bind(nodeId, since)
    .all();
  return rows<Record<string, number | null>>(res).map((r) => ({
    ts: r.b as number, // bucket arithmetic already yields milliseconds
    cpu: r.cpu,
    memUsed: r.mem_used,
    memTotal: r.mem_total,
    diskReadBps: r.disk_read_bps,
    diskWriteBps: r.disk_write_bps,
    netInBps: r.net_in_bps,
    netOutBps: r.net_out_bps,
    load1: r.load1,
  }));
}

export async function latestMetrics(db: DB, nodeId: string): Promise<MetricsRow | null> {
  const res = await db.prepare('SELECT * FROM metrics WHERE node_id = ? ORDER BY ts DESC LIMIT 1').bind(nodeId).all();
  return rows<MetricsRow>(res)[0] ?? null;
}

export async function pruneMetrics(db: DB, keepMs: number): Promise<void> {
  // per-node PK-bounded deletes: each statement scans only the rows it
  // deletes (node_id, ts is the primary key), never the whole table
  const nodes = await db.prepare('SELECT id FROM nodes').all();
  const cutoff = Date.now() - keepMs;
  for (const n of rows<{ id: string }>(nodes)) {
    await db.prepare('DELETE FROM metrics WHERE node_id = ? AND ts < ?').bind(n.id, cutoff).run();
  }
}

export async function pruneAlerts(db: DB, keepMs: number): Promise<void> {
  // idx_alerts_ts makes this a bounded index-range delete
  await db.prepare('DELETE FROM alerts WHERE ts < ?').bind(Date.now() - keepMs).run();
}

export async function pruneAudit(db: DB, keepMs: number): Promise<void> {
  await db.prepare('DELETE FROM audit_logs WHERE ts < ?').bind(Date.now() - keepMs).run();
}

export async function pruneWorkflowRuns(db: DB, keepMs: number): Promise<void> {
  const old = await db
    .prepare('SELECT id FROM workflow_runs WHERE created_at < ? LIMIT 200')
    .bind(Date.now() - keepMs)
    .all();
  for (const r of rows<{ id: string }>(old)) {
    await db.prepare('DELETE FROM run_steps WHERE run_id = ?').bind(r.id).run();
    await db.prepare('DELETE FROM workflow_runs WHERE id = ?').bind(r.id).run();
  }
}

// ─── Exec tasks ──────────────────────────────────────────────────────────

export interface TaskRow {
  id: string;
  kind: string;
  ref_id: string | null;
  node_id: string;
  script: string;
  lang: string;
  env_enc: string;
  timeout_ms: number;
  status: string;
  exit_code: number | null;
  attempts: number;
  retry_of: string | null;
  retry_at: number | null;
  log_size: number;
  log_path: string | null;
  log_tail: string | null;
  error: string | null;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const INLINE_LOG_LIMIT = 64_000; // bytes kept inline in D1; larger goes to R2

export async function createTask(
  db: DB,
  t: {
    id: string;
    kind: 'manual' | 'cron' | 'workflow';
    refId?: string | null;
    nodeId: string;
    script: string;
    lang: ExecLang;
    env?: Record<string, string>;
    envEnc?: string;
    timeoutMs: number;
    createdBy?: string | null;
    retryOf?: string | null;
    retryAt?: number | null;
    attempts?: number;
    status?: ExecStatus;
  },
): Promise<void> {
  let envEnc = t.envEnc ?? '';
  if (!envEnc && t.env && Object.keys(t.env).length > 0) {
    throw new Error('caller must pre-encrypt env (envEnc)');
  }
  await db
    .prepare(
      `INSERT INTO exec_tasks (id, kind, ref_id, node_id, script, lang, env_enc, timeout_ms, status,
        attempts, retry_of, retry_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      t.id,
      t.kind,
      t.refId ?? null,
      t.nodeId,
      t.script,
      t.lang,
      envEnc,
      t.timeoutMs,
      t.status ?? 'queued',
      t.attempts ?? 0,
      t.retryOf ?? null,
      t.retryAt ?? null,
      t.createdBy ?? null,
      Date.now(),
    )
    .run();
}

export async function getTask(db: DB, taskId: string): Promise<TaskRow | null> {
  const res = await db.prepare('SELECT * FROM exec_tasks WHERE id = ?').bind(taskId).all();
  return rows<TaskRow>(res)[0] ?? null;
}

export async function markTaskRunning(db: DB, taskId: string): Promise<void> {
  await db
    .prepare(`UPDATE exec_tasks SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?`)
    .bind(Date.now(), taskId)
    .run();
}

export async function finishTask(
  db: DB,
  taskId: string,
  patch: { status: ExecStatus; exitCode: number | null; error?: string | null; logSize?: number; logTail?: string | null; logPath?: string | null },
): Promise<void> {
  const tail = patch.logTail != null ? patch.logTail.slice(-INLINE_LOG_LIMIT) : undefined;
  await db
    .prepare(
      `UPDATE exec_tasks SET status = ?, exit_code = ?, error = ?, log_size = COALESCE(?, log_size),
        log_tail = COALESCE(?, log_tail), log_path = COALESCE(?, log_path), finished_at = ? WHERE id = ?`,
    )
    .bind(
      patch.status,
      patch.exitCode,
      patch.error ?? null,
      patch.logSize ?? null,
      tail ?? null,
      patch.logPath ?? null,
      Date.now(),
      taskId,
    )
    .run();
}

export interface TaskListFilter {
  nodeId?: string;
  status?: ExecStatus;
  kind?: string;
  refId?: string;
  limit?: number;
  offset?: number;
}

export async function listTasks(db: DB, f: TaskListFilter): Promise<{ tasks: TaskRow[]; total: number }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.nodeId) {
    where.push('node_id = ?');
    binds.push(f.nodeId);
  }
  if (f.status) {
    where.push('status = ?');
    binds.push(f.status);
  }
  if (f.kind) {
    where.push('kind = ?');
    binds.push(f.kind);
  }
  if (f.refId) {
    where.push('ref_id = ?');
    binds.push(f.refId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(f.limit ?? 50, 200);
  const offset = f.offset ?? 0;
  const res = await db
    .prepare(`SELECT * FROM exec_tasks ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all();
  const count = await db.prepare(`SELECT COUNT(*) AS c FROM exec_tasks ${clause}`).bind(...binds).all();
  const total = (rows<{ c: number }>(count)[0]?.c as number) ?? 0;
  return { tasks: rows<TaskRow>(res), total };
}

export async function countActiveTasks(db: DB): Promise<number> {
  const res = await db
    .prepare(`SELECT COUNT(*) AS c FROM exec_tasks WHERE status IN ('queued','running')`)
    .all();
  return (rows<{ c: number }>(res)[0]?.c as number) ?? 0;
}

export async function tasksForNodeNeedingFail(db: DB, nodeId: string): Promise<TaskRow[]> {
  const res = await db
    .prepare(`SELECT * FROM exec_tasks WHERE node_id = ? AND status IN ('queued','running')`)
    .bind(nodeId)
    .all();
  return rows<TaskRow>(res);
}

// ─── Env encryption helpers ──────────────────────────────────────────────

export async function encryptEnv(secret: string, env: Record<string, string> | undefined): Promise<string> {
  if (!env || Object.keys(env).length === 0) return '';
  return aesEncrypt(secret, JSON.stringify(env));
}

export async function decryptEnv(secret: string, envEnc: string): Promise<Record<string, string>> {
  if (!envEnc) return {};
  try {
    return parseJson<Record<string, string>>(await aesDecrypt(secret, envEnc), {});
  } catch {
    return {};
  }
}

export function taskEnvPayload(m: Record<string, string>): Record<string, string> {
  return m;
}

// ─── R2 log archive ──────────────────────────────────────────────────────

export function logKey(taskId: string): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `exec/${y}/${mo}/${taskId}.log`;
}

export async function archiveLog(r2: R2Bucket, key: string, content: string): Promise<number> {
  const bytes = b64encode(new TextEncoder().encode(content));
  const bin = b64decode(bytes);
  await r2.put(key, bin);
  return bin.length;
}

export async function readLog(r2: R2Bucket, key: string): Promise<string | null> {
  const obj = await r2.get(key);
  if (!obj) return null;
  return await obj.text();
}

// ─── Audit / alerts ──────────────────────────────────────────────────────

export interface AuditInput {
  actor: string;
  action: string;
  target?: string;
  nodeId?: string | null;
  detail?: string | null;
  ip?: string | null;
}

export async function audit(db: DB, e: AuditInput): Promise<void> {
  await db
    .prepare('INSERT INTO audit_logs (id, ts, actor, action, target, node_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(
      crypto.randomUUID(),
      Date.now(),
      e.actor,
      e.action,
      e.target ?? '',
      e.nodeId ?? null,
      e.detail ?? null,
      e.ip ?? null,
    )
    .run();
}

export interface AuditFilter {
  action?: string;
  nodeId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// exact COUNT(*) would scan the whole audit table on every poll; this caps
// the scan at 10k rows and reports "10000+" beyond that
const AUDIT_COUNT_CAP = 10_000;

export async function listAudit(db: DB, f: AuditFilter): Promise<{ entries: Record<string, unknown>[]; total: number }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.action) {
    where.push('action = ?');
    binds.push(f.action);
  }
  if (f.nodeId) {
    where.push('node_id = ?');
    binds.push(f.nodeId);
  }
  if (f.search) {
    where.push('(actor LIKE ? OR action LIKE ? OR target LIKE ? OR detail LIKE ?)');
    const pat = `%${f.search}%`;
    binds.push(pat, pat, pat, pat);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(f.limit ?? 50, 200);
  const offset = f.offset ?? 0;
  const res = await db
    .prepare(`SELECT * FROM audit_logs ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all();
  const count = await db
    .prepare(`SELECT COUNT(*) AS c FROM (SELECT 1 FROM audit_logs ${clause} LIMIT ${AUDIT_COUNT_CAP + 1})`)
    .bind(...binds)
    .all();
  const total = Math.min((rows<{ c: number }>(count)[0]?.c as number) ?? 0, AUDIT_COUNT_CAP);
  return { entries: rows(res), total };
}

export async function addAlert(db: DB, a: { level: 'info' | 'warn' | 'error'; title: string; message: string; nodeId?: string | null }): Promise<void> {
  await db
    .prepare('INSERT INTO alerts (id, ts, level, title, message, node_id, notified) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .bind(crypto.randomUUID(), Date.now(), a.level, a.title, a.message, a.nodeId ?? null)
    .run();
}

export async function listAlerts(db: DB, limit = 20): Promise<Record<string, unknown>[]> {
  const res = await db.prepare('SELECT * FROM alerts ORDER BY ts DESC LIMIT ?').bind(limit).all();
  return rows(res);
}

export async function markAlertNotified(db: DB, alertId: string): Promise<void> {
  await db.prepare('UPDATE alerts SET notified = 1 WHERE id = ?').bind(alertId).run();
}

// ─── Settings (k/v, secrets encrypted) ───────────────────────────────────

export async function getSetting(db: DB, key: string): Promise<Record<string, unknown> | null> {
  const res = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).all();
  const raw = rows<{ value: string }>(res)[0]?.value;
  if (!raw) return null;
  return parseJson(raw, null);
}

export async function putSetting(db: DB, key: string, value: unknown): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value))
    .run();
}

// ─── Registration keys ───────────────────────────────────────────────────

export interface RegKeyRow {
  id: string;
  name: string;
  key_hash: string;
  prefix: string;
  enabled: number;
  created_at: number;
  last_used_at: number | null;
}

export async function listRegKeys(db: DB): Promise<RegKeyRow[]> {
  const res = await db.prepare('SELECT * FROM reg_keys ORDER BY created_at DESC').all();
  return rows<RegKeyRow>(res);
}

export async function insertRegKey(db: DB, k: RegKeyRow): Promise<void> {
  await db
    .prepare('INSERT INTO reg_keys (id, name, key_hash, prefix, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(k.id, k.name, k.key_hash, k.prefix, k.enabled, k.created_at)
    .run();
}

export async function deleteRegKey(db: DB, keyId: string): Promise<void> {
  await db.prepare('DELETE FROM reg_keys WHERE id = ?').bind(keyId).run();
}

export async function touchRegKey(db: DB, keyId: string): Promise<void> {
  await db.prepare('UPDATE reg_keys SET last_used_at = ? WHERE id = ?').bind(Date.now(), keyId).run();
}

// ─── Cron jobs ───────────────────────────────────────────────────────────

export interface CronRow {
  id: string;
  name: string;
  expr: string;
  target_type: string;
  target_value: string | null;
  script: string;
  lang: string;
  timeout_ms: number;
  retries: number;
  env_enc: string;
  enabled: number;
  next_run: number | null;
  last_run: number | null;
  created_at: number;
  updated_at: number;
}

export async function listCronJobs(db: DB, dueBefore?: number): Promise<CronRow[]> {
  if (dueBefore != null) {
    const res = await db
      .prepare('SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?')
      .bind(dueBefore)
      .all();
    return rows<CronRow>(res);
  }
  const res = await db.prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC').all();
  return rows<CronRow>(res);
}

export async function getCronJob(db: DB, jobId: string): Promise<CronRow | null> {
  const res = await db.prepare('SELECT * FROM cron_jobs WHERE id = ?').bind(jobId).all();
  return rows<CronRow>(res)[0] ?? null;
}

export async function updateCronNextRun(db: DB, jobId: string, nextRun: number | null, lastRun?: number): Promise<void> {
  if (lastRun != null) {
    await db.prepare('UPDATE cron_jobs SET next_run = ?, last_run = ? WHERE id = ?').bind(nextRun, lastRun, jobId).run();
  } else {
    await db.prepare('UPDATE cron_jobs SET next_run = ? WHERE id = ?').bind(nextRun, jobId).run();
  }
}

export async function insertCronJob(
  db: DB,
  j: {
    id: string;
    name: string;
    expr: string;
    target_type: string;
    target_value: string | null;
    script: string;
    lang: string;
    timeout_ms: number;
    retries: number;
    env_enc: string;
    enabled: number;
    next_run: number | null;
    created_at: number;
    updated_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cron_jobs (id, name, expr, target_type, target_value, script, lang, timeout_ms, retries,
        env_enc, enabled, next_run, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      j.id,
      j.name,
      j.expr,
      j.target_type,
      j.target_value,
      j.script,
      j.lang,
      j.timeout_ms,
      j.retries,
      j.env_enc,
      j.enabled,
      j.next_run,
      j.created_at,
      j.updated_at,
    )
    .run();
}

export async function updateCronJob(db: DB, jobId: string, j: Record<string, unknown>): Promise<void> {
  await db
    .prepare(
      `UPDATE cron_jobs SET name = ?, expr = ?, target_type = ?, target_value = ?, script = ?, lang = ?,
        timeout_ms = ?, retries = ?, env_enc = ?, enabled = ?, next_run = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      j.name,
      j.expr,
      j.target_type,
      j.target_value,
      j.script,
      j.lang,
      j.timeout_ms,
      j.retries,
      j.env_enc,
      j.enabled,
      j.next_run,
      j.updated_at,
      jobId,
    )
    .run();
}

export async function deleteCronJob(db: DB, jobId: string): Promise<void> {
  await db.prepare('DELETE FROM cron_jobs WHERE id = ?').bind(jobId).run();
}

export async function toggleCronJob(db: DB, jobId: string): Promise<boolean> {
  const job = await getCronJob(db, jobId);
  if (!job) return false;
  const enabled = job.enabled === 1 ? 0 : 1;
  await db.prepare('UPDATE cron_jobs SET enabled = ? WHERE id = ?').bind(enabled, jobId).run();
  return enabled === 1;
}

// ─── Users ───────────────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
}

export async function getUserByName(db: DB, username: string): Promise<UserRow | null> {
  const res = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).all();
  return rows<UserRow>(res)[0] ?? null;
}

export async function countUsers(db: DB): Promise<number> {
  const res = await db.prepare('SELECT COUNT(*) AS c FROM users').all();
  return (rows<{ c: number }>(res)[0]?.c as number) ?? 0;
}

export async function insertUser(db: DB, u: UserRow): Promise<void> {
  await db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').bind(
    u.id,
    u.username,
    u.password_hash,
    u.role,
    Date.now(),
  ).run();
}

export async function updateUserPassword(db: DB, userId: string, hash: string): Promise<void> {
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, userId).run();
}

// ─── Workflow runs ───────────────────────────────────────────────────────

export interface RunRow {
  id: string;
  def_id: string;
  def_name: string;
  graph: string;
  status: string;
  created_at: number;
  finished_at: number | null;
}

export interface RunStepRow {
  run_id: string;
  step_id: string;
  label: string;
  type: string;
  status: string;
  task_ids: string;
  exit_code: number | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export async function getRun(db: DB, runId: string): Promise<RunRow | null> {
  const res = await db.prepare('SELECT * FROM workflow_runs WHERE id = ?').bind(runId).all();
  return rows<RunRow>(res)[0] ?? null;
}

export async function listRunSteps(db: DB, runId: string): Promise<RunStepRow[]> {
  const res = await db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY started_at ASC, step_id ASC').bind(runId).all();
  return rows<RunStepRow>(res);
}

export async function setStepStatus(db: DB, runId: string, stepId: string, patch: {
  status?: string;
  taskIds?: string[];
  exitCode?: number | null;
  error?: string | null;
  started?: boolean;
  finished?: boolean;
}): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.status) {
    sets.push('status = ?');
    binds.push(patch.status);
  }
  if (patch.taskIds) {
    sets.push('task_ids = ?');
    binds.push(JSON.stringify(patch.taskIds));
  }
  if (patch.exitCode !== undefined) {
    sets.push('exit_code = ?');
    binds.push(patch.exitCode);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    binds.push(patch.error);
  }
  if (patch.started) {
    sets.push('started_at = ?');
    binds.push(Date.now());
  }
  if (patch.finished) {
    sets.push('finished_at = ?');
    binds.push(Date.now());
  }
  if (!sets.length) return;
  await db
    .prepare(`UPDATE run_steps SET ${sets.join(', ')} WHERE run_id = ? AND step_id = ?`)
    .bind(...binds, runId, stepId)
    .run();
}

export async function findStepsByTask(db: DB, taskId: string): Promise<RunStepRow[]> {
  const res = await db.prepare('SELECT * FROM run_steps WHERE task_ids LIKE ?').bind(`%"${taskId}"%`).all();
  return rows<RunStepRow>(res);
}

// ─── Workflow definitions ────────────────────────────────────────────────

export interface WorkflowDefRow {
  id: string;
  name: string;
  graph: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export async function listWorkflowDefs(db: DB): Promise<WorkflowDefRow[]> {
  const res = await db.prepare('SELECT * FROM workflow_defs ORDER BY updated_at DESC').all();
  return rows<WorkflowDefRow>(res);
}

export async function getWorkflowDef(db: DB, defId: string): Promise<WorkflowDefRow | null> {
  const res = await db.prepare('SELECT * FROM workflow_defs WHERE id = ?').bind(defId).all();
  return rows<WorkflowDefRow>(res)[0] ?? null;
}

export async function createWorkflowDef(db: DB, d: WorkflowDefRow): Promise<void> {
  await db
    .prepare('INSERT INTO workflow_defs (id, name, graph, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(d.id, d.name, d.graph, d.enabled, d.created_at, d.updated_at)
    .run();
}

export async function updateWorkflowDef(db: DB, defId: string, d: { name: string; graph: string; updated_at: number }): Promise<void> {
  await db.prepare('UPDATE workflow_defs SET name = ?, graph = ?, updated_at = ? WHERE id = ?').bind(d.name, d.graph, d.updated_at, defId).run();
}

export async function deleteWorkflowDef(db: DB, defId: string): Promise<void> {
  await db.prepare('DELETE FROM workflow_defs WHERE id = ?').bind(defId).run();
}

// ─── Terminal sessions (audit trail) ─────────────────────────────────────

export async function closeTerminalSession(db: DB, sessionId: string): Promise<void> {
  await db.prepare('UPDATE terminal_sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL').bind(Date.now(), sessionId).run();
}

export async function listTerminalSessions(db: DB, limit = 50): Promise<Record<string, unknown>[]> {
  const res = await db.prepare('SELECT * FROM terminal_sessions ORDER BY opened_at DESC LIMIT ?').bind(limit).all();
  return rows(res);
}
