# Assessment: Rotation ritual (Stage 2)

- **Date:** 2026-07-06
- **Source:** deferred queue item 1 (walking-skeleton assessment); vision doc
  "Session & context model"; `contracts/assistant-session.md` rotate() surface.
- **Decision:** ACCEPT as a single stage, depends-on 1 (merged, shipped v0.0.1)

## Claim/reality verification

| Claim | Reality | Verdict |
|---|---|---|
| rotate()/RotationRecord already contracted | `contracts/assistant-session.md` lines 20–33 | holds — no new contract |
| sessions table rotation-ready | `migrations/0001_init.sql`: `rotated_at`, `rotation_reason`, `is_current` + index | holds |
| Nothing implements rotation yet | `src/session/manager.ts` has only the 'died' cleanup path | holds |
| Fresh sessions start bare (seeding is net-new) | no seed/system-prompt code in manager | holds |
| No scheduler exists | no `src/scheduler` | holds — stage ships a minimal in-daemon daily check; general scheduler stays a later stage |
| Turn counting needs schema | no counter column | additive migration 0002 (column + default) — allowed |

## Scoping decisions

- **Includes its own daily trigger** (minimal interval check in the daemon) so the
  stage is shippable and observable alone; the later scheduler/watchdog stage
  generalizes triggers without touching the ritual.
- **Memory promotion is deliberately dumb** (append + index); dedup/curation
  intelligence can be a later enhancement once real usage shows the shape.
- **Manual rotation not operator-exposed** — capability wiring (later stage) owns
  operator tools; rotate() is exposed internally.
- Summary-turn failure must not block rotation (a wedged session retiring itself is
  the point) — spec makes this explicit.

## Contract safety

Implements the frozen assistant-session contract as written; consumes send() from
webex-ingress. No new seam, no edits, additive migration only.
