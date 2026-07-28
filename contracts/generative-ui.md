# Contract: generative-ui

- **Status:** frozen v1
- **Owner:** transport module (`/api/v1/ui/*` doors + MCP registry mapping) +
  `bin/nightshift` (the `ui` verb family). The UI registry module owns the
  schema and validator. (ADRs 0013–0015.)

## Exposes

**Additive control-API doors** under `/api/v1/ui/*` — loopback-only, bearer
`NIGHTSHIFT_API_TOKEN`, same `{ ok: true, ... } | { ok: false, error }`
discipline as contracts/control-api.md (which this contract extends and does
not edit). ALL doors and CLI verbs exist only when
`NIGHTSHIFT_GENERATIVE_UI_ENABLED=true` (default off; off = 404, feature
absent).

- `POST /api/v1/ui/validate` — body `{ html }` → `{ ok, verdict }`.
  Dry-run validation; never writes. The revise loop uses this so failed
  attempts consume no version numbers.
- `POST /api/v1/ui/resources` — body `{ name, html, requestedTools: string[],
  provenance }` → `{ ok, resource: UiResourceRecord }` with the next version
  assigned and made active. Validation failure → HTTP 422
  `{ ok: false, error, verdict }` and NOTHING is registered.
  `requestedTools` entries must name tools the MCP door advertises; unknown
  names → 422.
- `GET /api/v1/ui/resources` → `{ ok, resources: UiResourceRecord[] }` —
  active version per name, HTML omitted (`htmlBytes` size instead). The
  queryable registry (memory-graph design hook).
- `GET /api/v1/ui/resources/<name>` → `{ ok, name, active, versions:
  UiResourceRecord[] }` — all versions, HTML omitted.
- `GET /api/v1/ui/resources/<name>/<version>` → `{ ok, resource }` WITH
  `html`.
- `POST /api/v1/ui/resources/<name>/activate` — body `{ version }` →
  `{ ok, resource }`. Rollback = activating a prior version. 404 unknown
  name/version.
- `POST /api/v1/ui/grants` — body `{ name, tool, approvalText }` →
  `{ ok, grant: UiGrantRecord }`. Records the owner's in-chat approval
  durably; idempotent per (name, tool) while ungranted-or-revoked.
- `POST /api/v1/ui/grants/revoke` — body `{ name, tool }` → `{ ok, grant }`
  (sets `revokedAt`; rows are never deleted).

**CLI** (`bin/nightshift`, 1:1 with the doors, `--json` for raw API JSON,
exit 0 on `ok:true`): `nightshift ui validate <file>`, `ui install <file>
--name <n> --tools <a,b> --provenance <text>`, `ui list`, `ui show <name>
[<version>]`, `ui activate <name> <version>`, `ui grant <name> <tool>
--approval <text>`, `ui revoke <name> <tool>`.

**MCP surface (registry mapping)** on the existing `/app/v1/mcp` door
(contracts/app-ingress.md, ADR 0012 — shapes unchanged):

- `resources/list` = the hand-authored `ui://nightshift/jobs@v1` (always,
  flag-independent) **plus**, when the flag is on, one entry per registry
  name: the ACTIVE version as `ui://nightshift/<name>@v<N>`, `mimeType:
  text/html`, `_meta["ui/tools"]` = `granted(name) ∩
  requestedTools(version)` (empty array when nothing granted — zero-trust).
- `resources/read` serves any exact registered `@vN` uri (active or not),
  same `_meta` rule evaluated at read time.
- Server capability `resources: { listChanged: true }`. `GET /app/v1/mcp`
  (standard streamable-HTTP SSE stream, same bearer + flag gate as POST)
  carries `notifications/resources/list_changed`, broadcast on register /
  activate / grant / revoke. Best-effort: zero open streams is normal.

## Consumes

- The UI registry module (SQLite, ADR 0004/0015): tables `ui_resources` and
  `ui_grants` via the migration ledger. The doors are thin — validation and
  registry logic live in the module, not the transport (control-api
  discipline).
- The validator (ADR 0014): deterministic static analysis enforcing
  `nightshift-client/contracts/ui-bridge.md` (external dependency; rule set
  follows it additively, never silently).
- The MCP tool catalog (`src/transport/app/mcp.ts` TOOLS): `requestedTools`
  and grants must reference those frozen names.
- Env: `NIGHTSHIFT_GENERATIVE_UI_ENABLED` ("true"/"false", default off,
  validated house-style).

## Schema / wire

- **Naming:** `name` matches `^[a-z][a-z0-9-]{1,39}$` and is not `jobs`
  (reserved by the hand-authored resource). Versions are integers from 1;
  uri is `ui://nightshift/<name>@v<N>`.
- **UiResourceRecord:** `{ name, version, active: boolean, requestedTools:
  string[], grantedTools: string[], provenance, createdAt, htmlBytes,
  html? }` — `grantedTools` is the computed intersection (what `_meta` will
  carry); `html` present only on the single-version GET.
- **UiGrantRecord:** `{ name, tool, approvalText, grantedAt,
  revokedAt: string | null }`.
- **Validator verdict:** `{ valid: boolean, violations: [{ rule, detail }]
  }`. Frozen rule ids (additive; each maps to a ui-bridge clause):
  `single-file`, `no-network`, `no-storage`, `no-navigation`,
  `bridge-only`, `degradable-render`, `size-cap` (256 KB),
  `well-formed`.
- **SQLite:** `ui_resources(id INTEGER PK, name TEXT, version INTEGER, html
  TEXT, requested_tools TEXT/*JSON*/, provenance TEXT, created_at TEXT,
  active INTEGER, UNIQUE(name, version))`;
  `ui_grants(id INTEGER PK, name TEXT, tool TEXT, approval_text TEXT,
  granted_at TEXT, revoked_at TEXT NULL)`.
- **Invariants:** exactly one active version per name; versions are never
  deleted or edited (a change is the next version); no grant row (or
  `revokedAt` set) → tool absent from `_meta["ui/tools"]`; validation
  precedes every registry write — there is no unvalidated insert path.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
