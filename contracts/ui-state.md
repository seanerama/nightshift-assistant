# Contract: ui-state

- **Status:** frozen v1
- **Owner:** UI registry/state module (`src/ui/`) + transport thin doors +
  `bin/nightshift` (`ui state` verbs). (ADR 0016; sibling of
  contracts/generative-ui.md — that contract is NOT edited.)

## Exposes

**MCP tools** on the existing `/app/v1/mcp` door, advertised ONLY when
`NIGHTSHIFT_GENERATIVE_UI_ENABLED=true` (flag off = the certified five-tool
catalog, byte-identical):

- `ui_state_get` — args `{ name }` → result body
  `{ ok, name, value: <json|null>, updatedAt: <ts|null> }`. `null` = never
  set. Unknown resource name → isError result (registry is the namespace
  authority).
- `ui_state_set` — args `{ name, value }` (value: any JSON ≤ 64 KB
  serialized) → `{ ok, name, updatedAt }`. Full-document replace,
  last-write-wins. Unknown name / oversize / non-JSON → isError result.

Both are grantable to generated resources via the contracts/generative-ui.md
grant flow (requestedTools may name them; `_meta["ui/tools"]` intersection
unchanged). Hand-authored `jobs@v1` does not use them.

**Control doors** (additive on control-api v1, same auth/flag discipline as
`/api/v1/ui/*` — 404 when the generative-ui flag is off):

- `GET /api/v1/ui/state/<name>` → `{ ok, name, value, updatedAt }`
  (`value: null` when never set). 404 unknown resource name.
- `POST /api/v1/ui/state/<name>` — body `{ value }` → `{ ok, name,
  updatedAt }`. Same validation as the tool. (The assistant's seeding door.)

**CLI:** `nightshift ui state <name>` (get, `--json` for raw),
`nightshift ui state <name> --set '<json>'` (replace).

## Consumes

- The UI registry (contracts/generative-ui.md) as the namespace authority:
  state rows exist only for registered resource names; deleting is not a v1
  operation (state is tiny and names are few).
- SQLite via the migration ledger (ADR 0004): table
  `ui_state(name TEXT PRIMARY KEY, value TEXT NOT NULL /*JSON*/,
  updated_at TEXT NOT NULL)`.
- Env: `NIGHTSHIFT_GENERATIVE_UI_ENABLED` (existing flag; no new flag).

## Schema / wire

- `value` is arbitrary JSON (object/array/scalar), serialized ≤ 65536 bytes
  UTF-8. Set replaces the whole document; there is no merge or keyed access
  in v1 (additive later).
- State attaches to the resource NAME — versions, activation, and rollback
  never touch it (ADR 0015 symmetry with grants).
- **Known v1 limitation (by design, ADR 0016):** MCP `tools/call` carries no
  caller identity, so any page granted `ui_state_set` can address any
  resource's state. The grant prompt must present the tools as
  namespace-wide trust. Future refinement (per-grant argument constraints or
  shell-attested caller identity) will be additive.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
