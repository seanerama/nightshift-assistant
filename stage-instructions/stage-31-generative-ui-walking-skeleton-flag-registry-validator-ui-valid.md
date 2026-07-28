# Stage 31: Generative UI walking skeleton: flag, registry, validator, ui validate/install/list, MCP listing

- **Type:** feature
- **Depends on:** none
- **Design:** docs/generative-ui-design.md · ADRs 0013/0014/0015 ·
  contract: contracts/generative-ui.md (frozen v1)

## Objectives

The thinnest end-to-end slice of the generative-UI spine: a single-file HTML
page travels chat-side CLI → deterministic validator → SQLite registry → MCP
`resources/list`/`resources/read` with a zero-trust empty allowlist. Invalid
HTML is refused with a machine-readable verdict and nothing is written. Flag
off = the feature is absent everywhere.

## What to build

1. **Flag:** `NIGHTSHIFT_GENERATIVE_UI_ENABLED` in `src/config.ts` —
   "true"/"false", default off, validated exactly like the existing flags
   (house style, see `NIGHTSHIFT_JOBS_ENABLED`).
2. **Migration `migrations/0009_ui_registry.sql`:** `ui_resources` and
   `ui_grants` per contracts/generative-ui.md §Schema (both created now even
   though grants machinery lands in Stage 33 — one migration for the seam).
   Safe to apply with the flag off.
3. **Registry module** (new, e.g. `src/ui/registry.ts`): install (validate →
   assign version 1 for a new name → insert active), list (active per name,
   no HTML), get-by-uri for MCP read. Name rule `^[a-z][a-z0-9-]{1,39}$`,
   `jobs` reserved. Version >1 paths land in Stage 32 — but the schema and
   `UNIQUE(name, version)` invariants are live now.
4. **Validator** (e.g. `src/ui/validator.ts`, ADR 0014): the full frozen rule
   set — `single-file`, `no-network`, `no-storage`, `no-navigation`,
   `bridge-only`, `degradable-render`, `size-cap` (256 KB), `well-formed` —
   returning `{ valid, violations: [{ rule, detail }] }`. Deterministic,
   conservative (reject on suspicion), no browser, no new heavy deps.
5. **Control doors** in `src/transport/api.ts` (additive on control-api v1,
   same pattern as stages 10/11/19): `POST /api/v1/ui/validate` (dry-run,
   never writes), `POST /api/v1/ui/resources` (register; 422 + verdict on
   invalid, nothing written), `GET /api/v1/ui/resources` (queryable
   registry). All three 404 when the flag is off. Thin doors — logic in the
   registry module.
6. **CLI verbs** in `bin/nightshift`: `ui validate <file>`,
   `ui install <file> --name <n> [--tools a,b] [--provenance <text>]`,
   `ui list` — 1:1 with the doors, `--json` passthrough, exit 0 on ok.
   `--tools` names must exist in the MCP TOOLS catalog (422 otherwise);
   they are recorded as `requestedTools` but grants don't exist yet, so
   `_meta["ui/tools"]` is ALWAYS `[]` this stage.
7. **MCP mapping** in `src/transport/app/mcp.ts`: when the flag is on,
   `resources/list` = hand-authored `jobs@v1` + one entry per active registry
   row (`ui://nightshift/<name>@v<N>`, `text/html`,
   `_meta["ui/tools"]: []`); `resources/read` serves registered uris.
   Flag off: today's behavior byte-identical.

## Interface contracts

- **Exposes:** the Stage-31 subset of contracts/generative-ui.md (validate /
  register / list doors, CLI verbs, registry schema, validator verdict).
  Later stages extend; nothing here may be reshaped by them.
- **Consumes:** contracts/control-api.md (auth/body discipline — NOT edited),
  contracts/app-ingress.md (mcp door — NOT edited),
  `nightshift-client/contracts/ui-bridge.md` (validator rules follow it),
  ADR 0004 migration ledger.

## Testing requirements

- **Validator fixtures** (`test/fixtures/ui/` or similar): one known-BAD page
  per rule id (8 fixtures, each failing exactly its rule), one trivial
  known-GOOD page, and **`src/transport/app/resources/jobs-v1.html` must
  PASS** — the drift detector between validator and ui-bridge.md.
- **Registry/door tests:** install good page → listed active v1; install
  invalid → 422 with verdict, table empty; duplicate name re-install → out of
  scope here (Stage 32) but must NOT corrupt (assert UNIQUE holds); reserved
  name `jobs` and malformed names → 422; flag off → doors 404, no registry
  rows in MCP list.
- **MCP integration test:** flag-on daemon against a scratch DB — CLI-install
  the good fixture, then over `POST /app/v1/mcp` assert `resources/list`
  contains `ui://nightshift/<name>@v1` with `_meta["ui/tools"]: []` and
  `resources/read` returns the exact HTML.
- **Conformance harness green in BOTH flag states** (pinned
  agent-app-conformance, as wired in Stage 24's CI leg).

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (here: the MCP list/read assertion doubles as the smoke asset —
      document the two `curl`/Inspector invocations in `docs/smoke/`)
- [ ] Additive migration only (no destructive schema change)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
