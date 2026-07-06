# Assessment: Walking skeleton (Stage 1)

- **Date:** 2026-07-06
- **Source:** Architect handoff (docs/ARCHITECTURE.md, "Walking skeleton — Stage 0")
- **Decision:** ACCEPT as a single stage

## Claim/reality verification

| Claim | Reality | Verdict |
|---|---|---|
| Fresh scaffold, no source | No `src/`, no `package.json` in tree | holds |
| CI hygiene-only, progressive gates expected | `ci.yml`: structure + gitleaks; comment invites gates with the skeleton | holds |
| Contracts frozen v1 | `webex-ingress`, `assistant-session`, `job-lifecycle` present | holds |
| Webex signs webhooks HMAC-SHA1 in `X-Spark-Signature` | Matches Webex API and old NSAF webhook code | holds |
| `claude` CLI + skills on the deploy host | True (NSAF runs there today); CI stubs the binary at the seam | verified at ship |
| New Webex bot identity exists | NOT yet — operator must create it (parallel-run) | prerequisite flagged in acceptance |

## Why one stage, not several

The skeleton's value is *end-to-end proof*; splitting transport/session/CI into
separate stages would produce stages that individually prove nothing and would each
merge unverifiable. Size stays honest by scoping relay-only (no rotation, no job
runner, no scheduler, no capabilities).

## Contract safety

Consumes all three frozen contracts additively; introduces no new seam. The
`job-lifecycle` state machine is implemented (transition helper + DDL) without the
runner itself — later stages consume the helper rather than re-litigating status
writes.

## Deferred (thin-backlog queue, in dependency order — future intake, not stages yet)

1. Rotation ritual (daily + size-cap)
2. Job runner + completion notifications
3. Scheduler + watchdog (email fallback per ADR 0005)
4. Capability wiring (jobs/ideas/builds/story/study/brief/server-ops tools)
5. Simplified promotion capability (open design question)
6. Help mode (adapted helper-bot, dark behind `HELP_ENABLED`)
7. Transition & old-NSAF retirement

Open questions carried: Webex threads↔sessions; IPJ integration surface; old NSAF
state migration.
