# NSAF Rebuild — Keep/Kill/Add Decisions

*Output of the informal keep/kill interview, 2026-07-06. This document is the input to the new project's vision/architecture phase. It records **what** the new system should be; **how** is deferred to architecture.*

## The decision

NSAF's core (orchestrator, Flask app + Webex bot, idea-generator, shared DB layer) will **not** be remediated. It is replaced by a new build: a **single-user personal assistant, accessible via Webex**, that does everything NSAF does — plus general assistant duties. The `skills/` pipelines (story, study, brief, sdd, verity, …) are healthy and carry over as the assistant's capability library, essentially unchanged.

The 37-item remediation plan (`nsaf-remediation-plan.md`) is retired with the old core, **except** the security items, which apply equally to the new build (see Security carryovers).

Prior art that feeds this design:
- `docs/webex-revamp.md` — the dispatcher→relay design. The new build goes *further* than that doc: full relay, no native command table at all.
- The remediation review — its structural findings (ENH-01…05) are requirements on the new design in the sense that the new architecture must not recreate those failure classes.

---

## Keep

| Feature | Verdict | Notes |
|---|---|---|
| **Autonomous app factory** (queue → unattended overnight Claude build via SDD → port allocation → Postgres provisioning → auto-launch) | **Keep as-is** | The heart of the system. Rebuilt on the new core's job model, but the operator experience is unchanged: queue an idea, wake up to a running app. |
| **Content pipelines** (story, study/sws, brief) | **Keep — core capabilities** | The assistant's main job. Invoked conversationally from Webex; skills stay the single source of truth for what they do. |
| **Idea generation** | **Keep, but on-demand** | "Give me 10 app ideas" as an assistant capability. **Kill** the scheduled daily cron + morning email ritual, the temperature-tier system, and the separate auto story/study idea pipelines. |
| **Promotion / deployment** | **Keep, simplified** | "Deploy this" remains a capability (currently: Dockerize → GitHub → Coolify → Cloudflare tunnel + DNS). Simplify the pipeline during architecture — fewer steps and/or fewer moving parts. Exact simplification TBD. |
| **Real-time notifications** (build complete, stall, failure) | **Keep — Webex only** | Delivered by the assistant in Webex. Email goes away entirely (no morning idea email, no evening digest email; a daily summary exists in the rotation ritual instead — see Session model). |
| **App/project lifecycle ops** (status, stop/start, archive, delete, restart, debug, modify) | **Keep** | As assistant capabilities/tools, not bot commands. |

## Kill

| Feature | Why |
|---|---|
| **Per-command bot dispatcher** (~30 `cmd_*` handlers, ~3,700 lines) | Full relay: every message goes to the Claude session; even "status" is a tool call. No command table to keep in sync. |
| **Web UIs** — morning idea-selection page and QA review page | Folded into chat ("queue 3 and 7", "promote habit-tracker"). No web app in the rebuild. |
| **Email** (morning idea list, evening digest) | Webex is the single channel. |
| **Vision intake flow** (`vision`/`questions`/`answer`/`review` multi-step Q&A) | Free-form conversation with the assistant replaces the hand-built state machine. |
| **Temperature tiers** (wild/warm/safe) | Just ask for the kind of ideas you want. |
| **Auto story/study idea pipelines** | Scheduled generation of story/study ideas goes; on-demand remains. |
| **Legacy orchestrator promotion checker** (Render-era) | Root cause of FIX-C1. Nothing like it returns. |

*(Undecided, default keep-as-tools: CSV export, token/cost reporting — cheap to carry, revisit at architecture.)*

## Add — new assistant duties

Beyond current NSAF capabilities, the assistant takes on:

1. **Research & briefings** — deep research on demand, news monitoring; the brief pipeline grows into general "look into X for me."
2. **Reminders & schedule** — time-based reminders, recurring task triggers, calendar awareness.
3. **Server/home ops** — manage the dev server and infrastructure conversationally: disk, services, deploys, logs.
4. **General agent tasks** — file wrangling, email drafts, document processing — whatever a Claude session with tools can do.
5. **Intelligent-Personal-Journal integration** — [seanerama/Intelligent-Personal-Journal](https://github.com/seanerama/Intelligent-Personal-Journal) is a separate wellness/journaling web app with its own scoped AI agents (capture parsing, medical/nutritional + life-coach insights). The assistant should be able to reach *some of its skills* — integration shape TBD at architecture (likely: assistant talks to IPJ's API for capture/query rather than absorbing its code). Note the natural dovetail: the assistant's daily rotation summaries are themselves journal-shaped.

## Session & context model (decided)

Single user. Three-layer design:

1. **Conversational session** — one resumable Claude Code session, resumed per incoming Webex message. **Rotate on time** (daily, e.g. 4am) with a **size-cap safety valve** (an unusually heavy day rotates early via the same ritual).
2. **Rotation ritual** — at rotation the outgoing session (a) writes a **summary of the day** — discussed, decided, built, unfinished — to a dated daily-log file; (b) promotes anything *durable* (preferences, project facts, decisions) into **memory files** that auto-load into every new session; (c) the **full transcript is archived** for reference (Claude Code already persists transcripts; the rotation job records/copies the location). The new morning session boots with memory files + yesterday's summary as seed context.
3. **Recovery** — "what exactly did I ask for on the 3rd?" is answered by the assistant grepping archived transcripts/daily logs; loss of context is a lookup, not a failure.

Hard rule: **long-running work never lives in the conversational session.** Builds, stories, research runs are background worker sessions with their own context; the front-door session dispatches them and relays their completion notifications.

## Transition (decided)

**Parallel, then cut over.** The new assistant is built alongside; old NSAF keeps running (overnight builds, current bot) until the new assistant covers daily use, then the old core is retired. Requires a second Webex bot identity during the overlap.

## Stack (decided)

**Whatever is cleanest.** No attachment to the current Flask/Python + Node split. Pick the best tools at architecture time for: Webex transport, session manager, rotation/scheduler, job runner.

## Security carryovers from the remediation plan

These findings must be requirements on the new build (they describe the surface, not the old code):

- **Webhook signature verification** (FIX-C2): HMAC-verify the raw body against the Webex secret, constant-time compare, fail closed when unconfigured; authorize against the *fetched* message's real sender.
- **Default-deny environment for spawned sessions** (FIX-H3): worker sessions get an allow-listed minimal env; infra credentials (Coolify, Cloudflare, Postgres-admin, bot token) are never passed to build/debug/worker sessions.
- **Minimal public surface** (FIX-H4): loopback bind; only the webhook endpoint is tunneled/exposed.
- **Pre-push secret scan + image-ignore** (FIX-M8): before any public GitHub push or image build.
- **Never combine debug mode with a public bind** (FIX-L1).

## Structural lessons the new core must not recreate

From the remediation review — stated as design requirements, not fixes:

- Session/job state must be **persisted and reconciled** against real processes (no in-memory-only spawn tracking → zombie "building" rows). (ENH-01)
- Status changes are **guarded transitions**; a late worker exit can never overwrite an operator decision. (ENH-02)
- **One schema source of truth**; no hand-copied DDL across components. (ENH-03)
- A **heartbeat watchdog** with a fallback alert channel; "waking up to silence" must be impossible. (ENH-04)
- Failures are **terminal, bounded, and visible** (retry caps, a real failed state, digest reporting). (ENH-05)
- Completion is an **explicit sentinel**, not a log-scrape heuristic. (ENH-10)
- The state database gets **real scheduled backups**. (ENH-09)

## Open questions for the architecture phase

- Exact shape of the simplified promotion pipeline (which of GitHub/Coolify/Cloudflare steps stay).
- Webex threads → separate sessions, or one session regardless of threading?
- IPJ integration surface (API? shared skills? read-only insights?).
- Fate of the existing state (ideas DB, project records): migrate, archive, or start clean with old NSAF's data kept read-only.
- Whether reminders/schedule use the OS scheduler, the assistant's own scheduler, or Claude Code's scheduled-agent facilities.
