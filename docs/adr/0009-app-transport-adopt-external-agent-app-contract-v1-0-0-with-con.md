# 0009. App transport: adopt external agent-app-contract v1.0.0 with conformance harness as definition of done

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

The Nightshift Client mobile app becomes a second front door to the assistant,
running in parallel with Webex (dual-run continues; Webex is untouched). The app
and the assistant live in different repos, so the seam between them needs a spec
neither side can drift from. `github:seanerama/agent-app-contract#v1.0.0`
already defines that spec (`contracts/app-ingress.md` normative, JSON Schemas in
`schemas/v1/` winning over prose) and ships a conformance harness
(`agent-app-conformance`) plus a reference mock (`mock-agent`).

The integration seam inside this repo is fixed: `InboundMessage → relay() →
AssistantReply` plus registering a second `send()` sink for proactive traffic.
Session manager, job runner, scheduler, watchdog, and all frozen contracts stay
untouched.

## Decision

- The app transport is a **sibling transport module** (`src/transport/app/`)
  inside the existing modular monolith (ADR 0001) — not a separate service.
- The **external contract pinned at `#v1.0.0`** is the normative spec, installed
  as a dev dependency for types and the harness. A repo-local
  `contracts/app-ingress.md` binds this repo to that pin and records the
  repo-specific choices (env names, bind, outbox, capability growth); it does
  not restate the wire spec.
- **`agent-app-conformance` exit 0 is the only definition of "done"** for every
  stage that touches the surface. The harness runs against the reference mock
  first to establish a known-good report, then against this daemon.
- Everything ships **dark behind `APP_TRANSPORT_ENABLED`** (default off). Flag
  off = routes absent; the SQLite migration is safe to apply either way.
- The manifest's `capabilities` list is **binding**: it starts at `["chat"]` and
  grows only as a stage lands with its harness checks green (`files`,
  `mcp-tools`, `mcp-apps-ui`). Declaring a capability the daemon can't serve is
  a contract violation, not a roadmap.
- `personId` is vestigial but **validated**: 403 unless it equals the configured
  owner id. It is not cleaned up — the contract keeps it.

## Alternatives considered

- **Write the wire spec in this repo** (like webex-ingress) — rejected: two
  repos would each hold half the truth and drift; the external repo with schemas
  + harness is the single source both sides certify against.
- **Track the contract repo's main branch** — rejected: an unpinned contract is
  not frozen. `#v1.0.0` only; a new pin is a new decision.
- **Separate service for the app surface** — rejected per the stack-and-topology
  guide and ADR 0001: it needs the live session manager and job runner in
  process; a service split buys nothing but a second deploy surface.

## Consequences

- "Done" is externally checkable — no self-graded stages on this surface.
- Upstream sharp edge accepted: v1.0.0 leaves outbox retention unspecified — we
  implement **no pruning** and leave a `TODO(contract-v1.0.1)` marker (ADR 0010).
- The `_meta["ui/tools"]` convention lives in the client repo
  (`nightshift-client/contracts/ui-bridge.md`), not the contract repo; Stage E
  follows it anyway and cites ui-bridge.md in the resource file header so the
  provenance is recorded (ADR 0012).
- A future contract v2 is a new repo-local contract file and a new pin — never
  an edit to this one.
