# App transport (`app-ingress`) — Architect handoff to /verity:plan

- **Date:** 2026-07-28 · **Role:** Architect
- **Decisions:** ADR 0009 (external contract + harness as done), ADR 0010
  (single-counter outbox), ADR 0011 (tailnet-private + bearer, 401-before-404),
  ADR 0012 (MCP/UI as thin doors).
- **Frozen contract:** `contracts/app-ingress.md`, pinned to
  `github:seanerama/agent-app-contract#v1.0.0`.
- **Topology:** unchanged — sibling transport module `src/transport/app/`
  inside the modular monolith (ADR 0001). Deployment target unchanged
  (`nsaf-dev-server`, ADR 0003, `.verity/deploy-access.md`).

## Frozen integration seam (do not widen)

`InboundMessage → relay() → AssistantReply` + register a second `send()` sink
for proactive traffic. Webex transport, session manager, job runner, scheduler,
watchdog, and all existing contracts stay untouched. `personId` is vestigial
but validated (403 unless owner). Everything dark behind
`APP_TRANSPORT_ENABLED`.

## Walking skeleton (feature Stage 0 — blocks all other app stages)

The thinnest slice that proves the spine AND the certification loop:

1. Dev dep `github:seanerama/agent-app-contract#v1.0.0` installed; run
   `npx agent-app-conformance` against `npx mock-agent` first and commit
   nothing until a passing reference report has been observed.
2. `src/transport/app/` module; migration adding `app_outbox` (safe with flag
   off); routes `/app/v1/health` + `/app/v1/manifest` (capabilities exactly
   `["chat"]`... but see note: if the harness requires chat checks for a
   declared `chat`, declare only what passes — declaring is binding).
3. Auth middleware: bearer `NIGHTSHIFT_APP_TOKEN`, 401-before-404, fail
   closed; flag off = routes absent.
4. **CI leg lands here, not at the end** (walking-skeleton-first guide): a CI
   job starts the daemon with the flag on against a scratch DB and runs the
   harness, required green. Every later stage inherits this gate — no
   "harness first runs at Stage F" failure mode.

**Exit:** harness runs in CI and locally, passes auth/manifest/health checks,
correctly skips undeclared capabilities; flag off leaves routes absent;
migration applies cleanly either way.

## Stage decomposition for the planner (prompt stages A–F, amended)

- **A = walking skeleton above** (amended: CI harness job moves into A).
- **B — chat triad:** POST /messages (schema validation, UUID dedup, 202
  before relay), SSE /events (Last-Event-ID resume, keep-alives),
  /outbox?after=; send() fan-out with durable-write-before-emit; `ack` /
  `reply` / `notice`. Exit: harness chat triad green incl. cursor.equivalence
  + dedup.
- **C — files:** POST /uploads → existing `uploads/<ts>-<name>` layout;
  GET /files/<id>; add `files` to manifest only when both work. Exit: harness
  upload→attach→retrieve round-trip green.
- **D — MCP tools:** official TS SDK, streamable HTTP, five thin-door tools
  (ADR 0012); add `mcp-tools`. Exit: harness MCP green; Inspector list+call
  over tailnet.
- **E — UI resource:** `ui://nightshift/jobs@v1`, single-file HTML,
  `_meta["ui/tools"]` per ui-bridge.md (cite it in the file header); add
  `mcp-apps-ui`. Exit: harness resource checks green; Inspector reads it.
- **F — deploy dark + certify live:** deploy flag-on, `ss -tlnp` bind check,
  tailnet curl smoke (401 without token / manifest with), SSE client observes
  a real reply, harness green against production, one Webex round-trip proving
  dual-run. Record truth in STATUS.md; owner's phone-to-agent Stage-0 exit
  (chat + kill a real job from the device) is **pending**, recorded as such —
  never claimed.

## Out of scope (do not plan)

Push notifications, token streaming, generative UI, Webex removal, watchdog
changes, any client-repo work, outbox pruning (TODO(contract-v1.0.1) marker
only).

## Drop-in feature catalog

`helper-bot` (In-App Help Agent) reviewed and **declined** for this effort:
it targets apps with their own web UI + chat loop; this feature is a transport
for an assistant that already is the chat loop, and client-repo UI work is
explicitly out of scope.
