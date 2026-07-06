# Assessment: Capability wiring (Stages 5 + 6)

- **Date:** 2026-07-06
- **Source:** deferred queue item 4; operator design session (ADR 0007: CLI-over-
  loopback spine, skills as payloads, MCP deferred; per-job-type permissions).
- **Decision:** SPLIT into two stages. Stage 5 (control API + CLI + session tool
  access) delivers observable value alone; Stage 6 (type registry + permission
  profiles) rides on it. New seam → new frozen contract `control-api` (v1).

## Claim/reality verification

| Claim | Reality | Verdict |
|---|---|---|
| Server has only /health + /webhook | `server.ts` route checks | holds — /api/v1 net-new |
| Sessions spawn with no permission flags | `manager.ts` args | holds — --allowedTools net-new; flag-off spawn must stay byte-identical |
| Workers spawn with no permission flags | `runner.ts:341` | holds — per-type profiles net-new |
| App.jobs / App.sessions exposed | `app.ts` | holds — API is a thin door |
| Skills available to host sessions | `~/.claude` symlinks → nsaf/skills monorepo | holds (verify per-skill at Stage 6 smoke) |
| workerEnv() is the single env builder | Stage 4 review | holds — token exclusion + per-type extras build on it |

## Key decisions

- **Bearer token on a loopback API**: defense-in-depth — a worker reaching
  127.0.0.1 must not be able to submit/kill jobs; token excluded from workerEnv().
- **CLI matcher syntax + permission-profile syntax flagged for verification
  against the installed claude CLI** (`--allowedTools` Bash rule form) — the
  builder must confirm on-host reality, not assume.
- **app-build type ships marked experimental** — the SDD posture needs its own
  hardening pass later; not this stage's fight.
- Rejected: MCP now (deferred, additive later), skills-in-session (violates the
  long-work rule), reply parsing (old dispatcher reborn).

## Contract safety

New `control-api` contract frozen at v1 (reserves the Stage 6 additive body).
job-lifecycle/assistant-session/webex-ingress consumed unchanged.
