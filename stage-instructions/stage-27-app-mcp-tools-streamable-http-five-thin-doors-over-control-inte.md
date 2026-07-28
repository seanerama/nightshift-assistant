# Stage 27: App MCP tools: streamable HTTP, five thin doors over control internals

- **Type:** feature
- **Depends on:** 24

## Objectives

The client gets structured control alongside chat: an MCP endpoint exposing
exactly five tools, each a thin door over the SAME internals the control API
uses (ADR 0012). No business logic in the transport; behavior parity with the
`nightshift` CLI is by construction, not by testing.

## What to build

1. **`POST /app/v1/mcp`:** official TypeScript MCP SDK
   (`@modelcontextprotocol/sdk`, pinned, lockfile committed), streamable-HTTP
   transport, mounted inside the Stage 24 app server — same bearer auth
   (401-precedes-404) and same `APP_TRANSPORT_ENABLED` gate as every other app
   route.
2. **Five tools:** `status`, `jobs_list`, `jobs_submit`, `jobs_kill`,
   `session_rotate`. Each validates arguments and calls the same `App`
   internals the control API's handlers call (`App.jobs`, `App.sessions` —
   `src/app.ts:202-203`; mirror the handler logic in
   `src/transport/server.ts`, do NOT loop back over HTTP to the control API).
   Tool results carry the frozen JobRecord/RotationRecord shapes
   (contracts/job-lifecycle.md, contracts/assistant-session.md) — no added
   fields, no renames.
3. **`jobs_submit`** accepts the same submit shapes as `POST /api/v1/jobs`
   (contracts/control-api.md), including typed `{ type, params }` payloads.
   `jobs_kill` and `session_rotate` are mutating — they stay owner-gated by
   the same bearer token; no extra confirmation layer is invented here (parity
   with the CLI).
4. **Manifest:** add `"mcp-tools"` when the harness MCP checks pass.

**Deliberately NOT in this stage:** UI resources (`mcp-apps-ui` stays
undeclared — Stage 28), any new tool beyond the five (capabilities are binding;
growth is additive later), prompts/sampling features of MCP, changes to the
control API or CLI.

## Interface contracts

- **Exposes:** the MCP endpoint + five tool names — these names are what the
  Stage 28 resource's `_meta["ui/tools"]` allowlist references; renaming later
  is a breaking change.
- **Consumes:** `contracts/app-ingress.md` v1; `contracts/control-api.md` v1
  (same doors, same shapes — parity, not duplication);
  `contracts/job-lifecycle.md` v1 + `contracts/assistant-session.md` v1
  (JobRecord/RotationRecord, unchanged).

## Testing requirements

- Unit/integration: tools/list returns exactly the five; each tool round-trips
  against a live in-process app with a scratch DB (submit → list shows it →
  kill → record shows killed; rotate returns a RotationRecord; status shape
  matches the control API's status fields it mirrors).
- Auth: MCP endpoint without token → 401; with token → serves.
- Parity guard: a test asserting the MCP `jobs_submit` and the control API
  handler accept the same typed payload and produce the same JobRecord (drift
  = bug by definition, ADR 0012).
- CI conformance job passes the harness MCP checks.
- **Post-deploy smoke asset — `docs/smoke/stage-27.md`** (runs at Stage 29 on
  live, authored now): MCP Inspector from a desktop on the tailnet connects to
  `http://<tailnet-ip>:<port>/app/v1/mcp` with the bearer token, lists the five
  tools, calls `status` and `jobs_list` successfully.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) still gates everything
- [ ] UI-smoke "observably-works" check authored (`docs/smoke/stage-27.md`,
      executed against live at Stage 29)
- [ ] Additive migration only (no destructive schema change)
- [ ] Exactly five tools; no business logic in the tool layer; frozen shapes
      unmodified
- [ ] `"mcp-tools"` declared only with harness MCP checks green
- [ ] Existing suite stays green; CI all-green including conformance

## Pipeline test: NO
