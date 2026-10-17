-- 0011_hook_messages: durable state for the hook ingress (contracts/
-- hook-ingress.md v1, ADR 0018, Stage 39). One row per submitted /hook/v1
-- turn, keyed by the CALLER's idempotency key (no "hook:" prefix) — the same
-- row is the durable dedup record (a re-POST starts no new turn) AND the poll
-- store behind GET /hook/v1/messages/<id>. Written by src/transport/hook.ts:
-- inserted 'pending' before relay() is enqueued, settled 'completed' (reply
-- text + rotated + filesOmitted count — never file paths) or 'failed'. A row
-- still 'pending' at daemon start is marked 'failed' (the turn cannot be
-- resumed). completed/failed rows older than HOOK_RETENTION_DAYS are pruned
-- on insert (created_at index). Applies safely with the flag off (routes
-- absent, table dormant). Additive only (ADR 0004): one new table, nothing
-- touched.

CREATE TABLE hook_messages (
  message_id    TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  reply_text    TEXT,
  rotated       INTEGER,
  files_omitted INTEGER,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);

CREATE INDEX idx_hook_messages_created_at ON hook_messages (created_at);

INSERT INTO schema_version (version, applied_at) VALUES (11, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
