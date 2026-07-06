-- 0003_sessions_pending: explicit pending marker for rotation-created sessions
-- (Stage 3 bug fix). relay() previously inferred pending-ness from turns == 0,
-- which misfired on rows 0002 backfilled to turns = 0 (live incident: the
-- daemon tried --session-id on an already-materialized session and the CLI
-- refused). Additive only (ADR 0004): new column, default backfill 0 —
-- pre-existing rows are NOT pending.

ALTER TABLE sessions ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;

INSERT INTO schema_version (version, applied_at) VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
