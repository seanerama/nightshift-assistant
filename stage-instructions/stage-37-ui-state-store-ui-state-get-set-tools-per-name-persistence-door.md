# Stage 37: UI-state store: ui_state_get/set tools, per-name persistence, doors + CLI

- **Type:** feature
- **Depends on:** 33,36
- **Design:** ADR 0016 · contract: contracts/ui-state.md (frozen v1) ·
  contracts/generative-ui.md NOT edited. Issue #84.

## Objectives

Generated pages get somewhere durable to put their data: a per-resource-name
JSON document (survives app restarts, version iteration, and rollback),
readable/writable by pages ONLY through owner-granted `ui_state_get`/
`ui_state_set` MCP tools, and readable/seedable by the assistant through
thin control doors + CLI. Flag off = surface byte-identical to v0.14.1.

## What to build

1. **Migration `migrations/0010_ui_state.sql`:** `ui_state(name TEXT PRIMARY
   KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)` — additive, safe with
   the flag off.
2. **State module** (extend `src/ui/` — registry or a sibling `state.ts`):
   `getState(name)` / `setState(name, value)` per the contract: registry is
   the namespace authority (unknown name → 404-class UiRegistryError),
   value must be JSON-serializable ≤ 65536 bytes UTF-8 (422-class error),
   full replace, `updated_at` ISO.
3. **MCP tools** in `src/transport/app/mcp.ts`: `ui_state_get` / `ui_state_set`
   appended to the catalog ONLY when `config.generativeUiEnabled` (make TOOLS
   a function of the flag; keep `status` FIRST and the five existing entries
   byte-identical when off). Tool handlers are thin doors over the state
   module; errors → isError results, house pattern.
4. **`MCP_TOOL_NAMES`** (`src/ui/registry.ts:30`): add both names so pages
   can request them and grants can name them (the generative-ui contract's
   grantable universe follows the advertised catalog).
5. **Control doors** in the flag-gated `/api/v1/ui/` block:
   `GET /api/v1/ui/state/<name>`, `POST /api/v1/ui/state/<name>` body
   `{ value }` — per contracts/ui-state.md. Thin; 404/422 discipline as the
   family.
6. **CLI:** `nightshift ui state <name>` (get; `--json`),
   `nightshift ui state <name> --set '<json>'`. USAGE updated.

## Interface contracts

- **Exposes:** contracts/ui-state.md v1, whole surface.
- **Consumes:** contracts/generative-ui.md (frozen — grant flow reused
  unchanged), contracts/app-ingress.md (mcp door — tool growth is additive;
  flag-off catalog byte-identical is the invariant), ADR 0004 ledger.

## Testing requirements

- State module: set→get round-trip (object/array/scalar), null before first
  set, replace semantics, unknown name 404-class, oversize (>65536B) and
  non-serializable 422-class, state survives install-v2 + activate-v1
  (version independence — the ADR 0015 symmetry).
- MCP: flag ON → catalog is the five + two (status still first), tools
  callable end-to-end (set via tools/call → get returns it; door-written
  state visible via tools/call and vice versa); flag OFF → catalog EXACTLY
  the certified five (update the "exactly five" pins at
  test/app-mcp.test.ts:206 area DELIBERATELY to be flag-conditional);
  isError paths.
- Grant integration: page requesting `ui_state_get,ui_state_set` installs;
  `_meta["ui/tools"]` empty → grant both → carries both; the generative-ui
  grant tests' universe now includes the new names.
- Doors/CLI: get/set round-trip over HTTP + CLI, 404s, body discipline,
  flag off → 404.
- Conformance harness green in BOTH flag states (CI legs unchanged).
- **Smoke asset:** docs/smoke/stage-37.md — live: seed state via CLI, read
  it back via an MCP tools/call, confirm it survives a version bump.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature
      (existing NIGHTSHIFT_GENERATIVE_UI_ENABLED — no new flag; flag off =
      five-tool catalog byte-identical)
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (docs/smoke/stage-37.md above)
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
