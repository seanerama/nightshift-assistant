# Feature assessment: app-ingress transport (Nightshift Client front door)

- **Date:** 2026-07-28 · **Role:** Intake/Planner (Mode A over
  `docs/app-transport-design.md`)
- **Decision:** **ACCEPT, SPLIT into stages 24–29** (feature), dependency-ordered.
- **Design inputs:** ADR 0009–0012; frozen `contracts/app-ingress.md` pinned to
  `agent-app-contract#v1.0.0`; architect handoff `docs/app-transport-design.md`.

## Claim / reality verification (against live source, 2026-07-28)

| Claim | Reality |
|---|---|
| Seam `InboundMessage → relay() → AssistantReply` exists | ✅ `src/session/manager.ts:161`; wired at `src/app.ts:191` |
| "Register a second send() sink" | ⚠️ **No sink registry exists.** `sender` is the single Webex `Sender` (`src/app.ts:84`) called directly at app.ts:119, 142, 151, 168. Stage 25 introduces a fan-out implementing the existing `Sender` interface (`src/transport/send.ts:28`); Webex leg byte-identical. |
| Daemon can serve tailnet-bound routes | ⚠️ Daemon binds `127.0.0.1` ONLY (`src/transport/server.ts:4`). The app module owns its own listener; bind via `NIGHTSHIFT_APP_BIND` (Stage 24), tailnet IP added at deploy (Stage 29). |
| `uploads/<ts>-<name>` layout exists | ✅ `src/types.ts:16` — InboundMessage.attachments semantics; Stage 26 reuses it |
| MCP tools can reuse control internals | ✅ `App.jobs` / `App.sessions` exposed (`src/app.ts:202-203`); control-api handlers in `src/transport/server.ts` are the pattern to mirror |
| `agent-app-contract#v1.0.0` + harness + mock exist | ✅ public repo, tag `v1.0.0`; root package builds workspaces on install, ships `agent-app-conformance` + `mock-agent` bins |
| SQLite migration path | ✅ `migrations/0001–0006`; next is `0007_app_outbox.sql` |
| CI to extend | ✅ `.github/workflows/ci.yml` (files / gitleaks / build-test); conformance job added in Stage 24 |

## Contract safety

Entirely additive. `webex-ingress`, `assistant-session`, `job-lifecycle`,
`control-api`, `promotion`, `site-promotion`: consumed, never modified. The new
surface is governed by the already-frozen `contracts/app-ingress.md`. The one
structural touch outside `src/transport/app/` is the Stage 25 fan-out, which
implements the existing `Sender` interface so webex-ingress send() semantics
hold by construction.

## Split rationale

Six stages, each ending at a harness or live-smoke exit (house rule): 24
walking skeleton + CI gate (moved forward from the prompt's Stage F per the
walking-skeleton guide); 25 chat triad + fan-out; 26 files; 27 MCP tools; 28 UI
resource; 29 deploy dark + certify live. Dependencies: 25→24, 26→25, 27→24,
28→27, 29→26+28 (27/28 can proceed in parallel with 25/26 if two builders run).

## Known risks / open points (recorded, not blocking)

- **Capability floor:** if `schemas/v1/` mandates `"chat"` as a manifest
  minimum, Stage 24 cannot pass with `[]` — the spec instructs the builder to
  stop and kick back rather than declare an unserved capability.
- **Outbox retention unspecified** upstream — no pruning; `TODO(contract-v1.0.1)`
  marker in migration 0007.
- **ui-bridge.md lives in the client repo** — external convention; provenance
  cited in the Stage 28 resource header.
- **Env-path discrepancy** in `.verity/deploy-access.md` (noticed 2026-07-24) —
  resolved as part of Stage 29.
- **Owner Stage-0 exit** (phone chat + kill a real job) is owner-performed
  after Stage 29 and recorded as PENDING in STATUS.md, never claimed.

## Amendment 1 (2026-07-28): chat-floor risk fired — stage 25 folded into 24

The recorded "capability floor" risk materialized on the executor's first pass:
`schemas/v1/manifest.json` requires `capabilities` to contain `"chat"` (an
empty list fails `manifest.ok`), and the harness runs the chat-triad checks
unconditionally (`messages.202`, `messages.dedup`, `messages.invalid.400`,
`messages.notowner.403`, `outbox.ok`, `outbox.ack`, `outbox.reply`,
`outbox.cursor.invalid`, `cursor.equivalence`) — "the chat triad is core and
gates nothing" per the schema's own description. A skeleton-only stage can
never reach exit 0, and ADR 0009 forbids both a subset gate and declaring an
unserved capability. **Resolution:** stage 24 absorbs the former stage 25
(chat triad + send fan-out); stage 25 superseded (file retained as record);
issue #61 closed as folded into #60; stage 26 now depends on 24. Backlog is
five live stages: 24, 26, 27, 28, 29 (deps: 26→24, 27→24, 28→27, 29→26+28).

## Out of scope (rejected for this effort)

Push notifications, token streaming, generative UI, Webex removal, watchdog
changes, client-repo work, outbox pruning. Catalog feature `helper-bot`:
declined (see docs/app-transport-design.md).
