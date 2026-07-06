-- 0004_jobs_retry_of: retry lineage for the job runner (Stage 4). The contract's
-- state machine has no running → queued edge, so a below-cap failure marks the
-- row terminal `failed` and auto-submits a FRESH queued row carrying the
-- incremented attempts count; retry_of links the new row to the row it retries.
-- Additive only (ADR 0004): new nullable column, existing rows are not retries.

ALTER TABLE jobs ADD COLUMN retry_of TEXT;

INSERT INTO schema_version (version, applied_at) VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
