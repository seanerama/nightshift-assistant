-- 0010_ui_state: per-resource-name UI state store (contracts/ui-state.md,
-- ADR 0016, Stage 37). ONE JSON document per registered resource NAME —
-- state attaches to the name, like grants (ADR 0015), so version iteration,
-- activation, and rollback never touch it by construction. value is the
-- serialized JSON document (object/array/scalar), <= 65536 bytes UTF-8 —
-- enforced by the state module (src/ui/state.ts), which is also where the
-- registry-is-the-namespace-authority rule lives: rows exist only for
-- registered names (no FK — ui_resources keys on (name, version); the module
-- performs the name-exists check on every read/write). set is a full-document
-- replace, last-write-wins; deletion is not a v1 operation. Applies safely
-- with the flag off (doors absent, tools unadvertised, table dormant).
-- Additive only (ADR 0004): one new table, nothing touched.

CREATE TABLE ui_state (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL, -- the serialized JSON document
  updated_at TEXT NOT NULL
);

INSERT INTO schema_version (version, applied_at) VALUES (10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
