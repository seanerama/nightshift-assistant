# Assessment: Job runner (Stage 4)

- **Date:** 2026-07-06
- **Source:** deferred queue item 2 (walking-skeleton assessment); `contracts/job-lifecycle.md`.
- **Decision:** ACCEPT as a single stage, depends-on 2 (merged; shipped v0.1.1)

## Claim/reality verification

| Claim | Reality | Verdict |
|---|---|---|
| jobs table already in the ladder | migration 0001 lines 23–38 — full JobRecord column set | holds — likely no migration |
| Guarded transitions ready | `src/db/transitions.ts` exports transitionJob with the contract's exact state machine | holds |
| Contract fully specifies sentinel + reconciliation | job-lifecycle.md: sentinel authority, PID reconciliation, bounded retries | holds |
| No runner module exists | no `src/jobs/` | holds — net-new |
| No env allow-list exists yet | no allowlist/minimal-env code in src/ | holds — net-new; FIX-H3's first enforcement point |
| Notice plumbing reusable | rotation's `lastOwnerRoomId` + notify wiring in app.ts | holds |

## Scoping decisions

- **Internal API only** — the contract mentions operator tools; tool exposure to
  the assistant session belongs to capability wiring (next stage). Same pattern as
  rotate() in Stage 2.
- **Retry semantics flagged for the builder**: the frozen state machine has no
  `running → queued` edge, while the contract text describes re-queue-until-cap.
  The spec offers two contract-true implementations (guarded re-queue vs. fresh
  retry row with `retry_of`) and requires the choice be documented in the PR —
  the transition helper must not be weakened either way.
- **Workers survive daemon restarts** (not killed on shutdown): persisted PIDs +
  the startup reconciler re-adopt them — this is the whole point of ENH-01 and
  gets an explicit test.
- **`workerEnv()` centralized** so every future spawn type (debug/modify flows in
  capability wiring) inherits default-deny for free.

## Contract safety

Implements job-lifecycle exactly; consumes webex-ingress send() for notices. No
new seam. Migration 0004 only if the retry-row approach is chosen (additive).
