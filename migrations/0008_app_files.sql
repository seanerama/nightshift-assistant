-- 0008_app_files: durable id→path mapping for the app transport's `files`
-- capability (contracts/app-ingress.md, Stage 26). GET /app/v1/files/<id> is
-- NEVER an arbitrary-path read: only ids present here resolve, and resolution
-- is re-confined to the deliverer's allow-listed roots (+ uploads/) at SERVE
-- time. Rows are written by POST /app/v1/uploads (id → uploads/<ts>-<name>)
-- and when a reply/notice outbox row names servable files. app_outbox is
-- untouched (ADR 0010 — its shape is frozen). No retention, same posture as
-- the outbox. Additive only (ADR 0004): new table, nothing touched.
-- TODO(contract-v1.0.1): pruning policy goes here (retention unspecified in v1.0.0)

CREATE TABLE app_files (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO schema_version (version, applied_at) VALUES (8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
