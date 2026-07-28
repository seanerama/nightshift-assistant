-- 0007_app_outbox: single-counter delivery outbox for the app transport
-- (contracts/app-ingress.md v1, ADR 0010, Stage 24). id is simultaneously the
-- SSE Last-Event-ID and the ?after= cursor — ONE counter, no exceptions; a
-- row is committed BEFORE any live emit, so a crash between commit and emit
-- loses nothing (the client re-reads from its cursor). type is ack | reply |
-- notice in contract v1.0.0 but deliberately UNCHECKED: the event-type set is
-- extensible additively (schemas/v1/event-envelope.json), and a CHECK would
-- turn an additive contract change into a schema migration. delivered_at is
-- bookkeeping, not a delivery guarantee — the cursor is the truth a client
-- trusts. Applies safely with the flag off (routes absent, table dormant).
-- Additive only (ADR 0004): new table, nothing touched.
-- TODO(contract-v1.0.1): pruning policy goes here (retention unspecified in v1.0.0)

CREATE TABLE app_outbox (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);

INSERT INTO schema_version (version, applied_at) VALUES (7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
