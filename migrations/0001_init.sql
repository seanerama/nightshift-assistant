-- 0001_init: sessions + jobs tables and the schema_version record.
-- The migration ladder is the ONLY DDL source (ADR 0004). Additive only.

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- assistant-session contract: current conversational session id,
-- started/rotated timestamps, rotation history (one row per session epoch).
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  rotated_at TEXT,
  rotation_reason TEXT,
  is_current INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_sessions_current ON sessions (is_current);

-- job-lifecycle contract: JobRecord, the only representation of a worker.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  schema INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'killed')),
  pid INTEGER,
  session_id TEXT,
  workdir TEXT NOT NULL,
  log_path TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  sentinel_path TEXT NOT NULL
);

CREATE INDEX idx_jobs_status ON jobs (status);

INSERT INTO schema_version (version, applied_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
