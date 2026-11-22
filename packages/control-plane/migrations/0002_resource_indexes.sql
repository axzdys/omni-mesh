-- OmniMesh D1 schema — 0002_resource_indexes
-- Adds indexes for the hot read paths so polling endpoints do bounded,
-- index-assisted scans instead of full table scans (D1 free tier budget).

CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status_retry ON exec_tasks(status, retry_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_created ON workflow_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_def ON workflow_runs(def_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_terminal_opened ON terminal_sessions(opened_at DESC);
