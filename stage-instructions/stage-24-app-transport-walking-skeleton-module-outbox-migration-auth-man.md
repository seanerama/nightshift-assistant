# Stage 24: App transport walking skeleton: module, outbox migration, auth, manifest, CI harness gate

- **Type:** feature
- **Depends on:** none

## Objectives

The thinnest slice of the app-ingress transport (contracts/app-ingress.md, ADR
0009–0011) that proves BOTH the spine and the certification loop: a new
`src/transport/app/` module serving `/app/v1/health` + `/app/v1/manifest` behind
auth and the dark flag, the `app_outbox` migration, and — critically — the CI
harness gate that every later app stage inherits. Per the architect handoff
(docs/app-transport-design.md), the CI leg lands HERE, not at deploy time.

## What to build

1. **Dev dependency:** `npm i -D github:seanerama/agent-app-contract#v1.0.0`
   (the ROOT package is the consumable — it builds its workspaces on install and
   exposes `./types`, `./conformance`, `./schemas/*`, plus the
   `agent-app-conformance` and `mock-agent` bins). **Before writing any route:**
   run `npx mock-agent` and `npx agent-app-conformance` against it, and commit a
   copy of the passing reference report to `docs/smoke/stage-24-mock-report.txt`
   — the builder must have SEEN a pass before attempting one.
2. **Module `src/transport/app/`** owning its OWN `node:http` server (the
   existing daemon server binds `127.0.0.1` only — `src/transport/server.ts:4` —
   and must not be touched). Bind addresses from `NIGHTSHIFT_APP_BIND`
   (comma-separated, default `127.0.0.1`; deploy adds the tailnet IP at Stage
   29). Port from `NIGHTSHIFT_APP_PORT`. Never `0.0.0.0`.
3. **Dark flag:** `APP_TRANSPORT_ENABLED` (default off). Flag off = the app
   server never starts and no route exists — not 403, absent. Startup with the
   flag on but `NIGHTSHIFT_APP_TOKEN` unset → refuse to start the app listener
   (fail closed), daemon otherwise healthy.
4. **Auth middleware:** bearer `NIGHTSHIFT_APP_TOKEN` on EVERY `/app/v1/` route;
   **401 precedes 404** — an unauthenticated request to any path, real or not,
   gets 401 so the surface is not enumerable (ADR 0011). Constant-time compare,
   same discipline as the control API token check.
5. **Migration `migrations/0007_app_outbox.sql`:** `app_outbox(id INTEGER
   PRIMARY KEY, type TEXT, payload TEXT, created_at TEXT, delivered_at TEXT
   NULL)` per ADR 0010. Additive; applies safely with the flag off. Include the
   `-- TODO(contract-v1.0.1): pruning` marker here (retention unspecified
   upstream).
6. **Routes:** `GET /app/v1/health`; `GET /app/v1/manifest`. **Capability
   declaration rule (binding, ADR 0009):** declare ONLY what passes. Read
   `schemas/v1/` and the mock's manifest first: if the schema permits an empty
   capability list, this stage declares `[]` and Stage 25 adds `"chat"`; if the
   schema mandates `"chat"` as a floor, STOP and kick back to the planner —
   do not declare a capability the daemon can't serve to make a check pass.
7. **CI harness gate:** new job in `.github/workflows/ci.yml` (alongside the
   existing files/gitleaks/build-test jobs): build, scratch SQLite DB in a temp
   dir, start the daemon with `APP_TRANSPORT_ENABLED=true` + a generated test
   token, run `agent-app-conformance` against it, **require exit 0**. This job
   is the standing certification gate for stages 25–28.

**Deliberately NOT in this stage:** POST /messages, SSE, outbox delivery logic
(the table exists, nothing writes it), uploads, MCP, any change to the Webex
transport, session manager, `src/app.ts` beyond constructing/starting the app
module behind the flag.

## Interface contracts

- **Exposes:** `/app/v1/health`, `/app/v1/manifest`, the `app_outbox` table, the
  auth middleware, and the CI conformance gate — the skeleton stages 25–28 hang
  routes on.
- **Consumes:** `contracts/app-ingress.md` v1 (this repo, frozen) pinned to
  `agent-app-contract#v1.0.0` (normative; schemas win over prose). Nothing from
  assistant-session/job-lifecycle yet. `webex-ingress`, `control-api`: untouched.

## Testing requirements

- Unit: auth middleware (no token → 401 on real AND fake paths; bad token → 401;
  good token + fake path → 404), flag-off = connection refused on the app port,
  fail-closed startup (flag on, token unset).
- Migration test in the existing migration-runner suite: 0007 applies on a fresh
  DB and on a DB at 0006; schema matches ADR 0010.
- The CI conformance job IS the contract test — it must be green in this
  stage's PR, harness exit 0 with the skeleton's declared capabilities and
  undeclared ones reported as skipped.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (n/a — no user-facing surface until Stage 29; the mock reference report
      stands in as the observable artifact)
- [ ] Additive migration only (no destructive schema change)
- [ ] Passing mock reference report committed BEFORE the daemon attempt
- [ ] 401-precedes-404 covered by test; capability list contains nothing unserved
- [ ] Existing suite stays green; CI all-green including the new conformance job

## Pipeline test: NO
