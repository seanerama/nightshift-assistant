-- 0009_ui_registry: generative-UI registry (contracts/generative-ui.md §Schema,
-- ADR 0015, Stage 31). ui_resources holds every installed version of every
-- generated single-file page — versions are NEVER deleted or edited (a change
-- is the next version; rollback is re-activation), exactly one active version
-- per name is the module-enforced invariant, and UNIQUE(name, version) is the
-- schema-enforced one. requested_tools is a JSON array of MCP tool names the
-- page ASKS for; what it is GRANTED lives in ui_grants — created here too
-- (both tables in one migration for the seam) even though the grant machinery
-- lands in Stage 33: until then no row is ever written, and _meta["ui/tools"]
-- is empty by construction (zero-trust). Grant rows, once they exist, are
-- never deleted — revocation sets revoked_at, keeping the approval history
-- durable. Applies safely with the flag off (doors absent, tables dormant).
-- Additive only (ADR 0004): new tables, nothing touched.

CREATE TABLE ui_resources (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  version         INTEGER NOT NULL,
  html            TEXT NOT NULL,
  requested_tools TEXT NOT NULL, -- JSON array of MCP tool names
  provenance      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  active          INTEGER NOT NULL,
  UNIQUE(name, version)
);

CREATE TABLE ui_grants (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  tool          TEXT NOT NULL,
  approval_text TEXT NOT NULL,
  granted_at    TEXT NOT NULL,
  revoked_at    TEXT
);

INSERT INTO schema_version (version, applied_at) VALUES (9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
