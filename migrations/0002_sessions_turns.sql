-- 0002_sessions_turns: per-session turn counter for the size-cap rotation
-- trigger (Stage 2). Additive only (ADR 0004): new column, default backfill.

ALTER TABLE sessions ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;

INSERT INTO schema_version (version, applied_at) VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
