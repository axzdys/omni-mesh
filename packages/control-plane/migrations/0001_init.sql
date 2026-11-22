-- OmniMesh D1 schema — 0001_init

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- pbkdf2$iters$saltB64$hashB64
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,          -- nd_xxxxxxxx
  name       TEXT NOT NULL,
  labels     TEXT NOT NULL DEFAULT '[]',-- JSON string[]
  status     TEXT NOT NULL DEFAULT 'offline',
  os         TEXT NOT NULL DEFAULT '',
  arch       TEXT NOT NULL DEFAULT '',
  version    TEXT NOT NULL DEFAULT '',  -- agent build version
  ip         TEXT NOT NULL DEFAULT '',
  hostname   TEXT NOT NULL DEFAULT '',
  last_seen  INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);

CREATE TABLE IF NOT EXISTS reg_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL,           -- sha256 hex of the raw key
  prefix       TEXT NOT NULL,           -- first 8 chars for display
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS metrics (
  node_id       TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  cpu           REAL,
  mem_used      REAL,
  mem_total     REAL,
  disk_total    REAL,
  disk_used     REAL,
  disk_read_bps REAL,
  disk_write_bps REAL,
  net_in_bps    REAL,
  net_out_bps   REAL,
  load1         REAL,
  procs         INTEGER,
  uptime        REAL,
  PRIMARY KEY (node_id, ts)
);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  expr         TEXT NOT NULL,           -- 5-field cron (UTC)
  target_type  TEXT NOT NULL,           -- node | tag | all
  target_value TEXT,
  script       TEXT NOT NULL,
  lang         TEXT NOT NULL DEFAULT 'shell',
  timeout_ms   INTEGER NOT NULL DEFAULT 600000,
  retries      INTEGER NOT NULL DEFAULT 0,
  env_enc      TEXT NOT NULL DEFAULT '',-- AES-GCM ciphertext (JSON k/v)
  enabled      INTEGER NOT NULL DEFAULT 1,
  next_run     INTEGER,
  last_run     INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cron_next ON cron_jobs(enabled, next_run);

CREATE TABLE IF NOT EXISTS exec_tasks (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,            -- manual | cron | workflow
  ref_id      TEXT,                     -- cron job id / workflow run id
  node_id     TEXT NOT NULL,
  script      TEXT NOT NULL,
  lang        TEXT NOT NULL DEFAULT 'shell',
  env_enc     TEXT NOT NULL DEFAULT '',
  timeout_ms  INTEGER NOT NULL DEFAULT 600000,
  status      TEXT NOT NULL DEFAULT 'queued',
  exit_code   INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  retry_of    TEXT,
  retry_at    INTEGER,
  log_size    INTEGER NOT NULL DEFAULT 0,
  log_path    TEXT,                     -- R2 object key when large
  log_tail    TEXT,                     -- last ~8KB stored inline
  error       TEXT,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON exec_tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_node ON exec_tasks(node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_ref ON exec_tasks(ref_id);

CREATE TABLE IF NOT EXISTS workflow_defs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  graph      TEXT NOT NULL,             -- WorkflowGraph JSON
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id          TEXT PRIMARY KEY,
  def_id      TEXT NOT NULL,
  def_name    TEXT NOT NULL,
  graph       TEXT NOT NULL,            -- snapshot
  status      TEXT NOT NULL DEFAULT 'running',
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS run_steps (
  run_id      TEXT NOT NULL,
  step_id     TEXT NOT NULL,
  label       TEXT NOT NULL,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  task_ids    TEXT NOT NULL DEFAULT '[]', -- JSON string[]
  exit_code   INTEGER,
  error       TEXT,
  started_at  INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id      TEXT PRIMARY KEY,
  ts      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT NOT NULL DEFAULT '',
  node_id TEXT,
  detail  TEXT,
  ip      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

CREATE TABLE IF NOT EXISTS alerts (
  id       TEXT PRIMARY KEY,
  ts       INTEGER NOT NULL,
  level    TEXT NOT NULL,
  title    TEXT NOT NULL,
  message  TEXT NOT NULL,
  node_id  TEXT,
  notified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                -- JSON; secrets stored AES-GCM encrypted
);

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id        TEXT PRIMARY KEY,
  node_id   TEXT NOT NULL,
  actor     TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);
