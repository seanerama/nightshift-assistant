-- 0006_promotions: PromotionRecord persistence (contracts/promotion.md v1,
-- Stage 11). One row per slug — UNIQUE(slug) enforces the contract's "exactly
-- ONE live promotion per slug" at the schema level: re-promoting updates the
-- row in place, never duplicates. steps is the contract's JSON array of
-- { name, ok, detail }. coolify_uuid is internal reuse state (NOT part of the
-- exposed record shape): the app created on first promotion, redeployed on
-- re-promotion. Additive only (ADR 0004): new table, nothing touched.

CREATE TABLE promotions (
  id           TEXT PRIMARY KEY,
  schema       INTEGER NOT NULL DEFAULT 1,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  source_path  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('planned', 'running', 'live', 'failed', 'removed')),
  repo_url     TEXT,
  url          TEXT,
  steps        TEXT NOT NULL DEFAULT '[]',
  coolify_uuid TEXT,
  created_at   TEXT NOT NULL,
  ended_at     TEXT,
  error        TEXT
);

INSERT INTO schema_version (version, applied_at) VALUES (6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
