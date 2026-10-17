# Nightshift Assistant — Architecture

*Architect-role output, 2026-07-06. Decisions live in `docs/adr/`; interface shapes in
`contracts/` (frozen v1, additive-only). Vision input: `docs/assistant-keep-kill.md`.*

## What this is

A single-user personal assistant fronted by Webex, replacing the NSAF core. One
message thread is the whole product surface: talk to it, and it answers, runs
capabilities (app builds, stories, studies, briefs, research, server ops), dispatches
long work to background sessions, and reports back. No web UI, no email (except the
watchdog's last-resort alarm), no command table.

## Topology (ADR 0001)

One daemon — **the Nightshift core** — Node LTS + TypeScript (ADR 0002), running under
systemd on the dev server (ADR 0003), state in one SQLite file with a migration ladder
(ADR 0004).

```
                       Webex cloud
                            │  (webhook POST, HMAC-verified)
        Tailscale Funnel — path scopes /webhook (+ /hook/v1)
                            │
┌───────────────────────────┴─────────────────────────────┐
│  nightshift-core (systemd service, loopback bind)        │
│                                                          │
│  transport ──InboundMessage──▶ session manager           │
│     ▲    ◀──send()── (replies, notices)   │              │
│     │                                     │ relay/rotate │
│     │                              conversational        │
│     │                              claude session        │
│     │                              (resumable child      │
│     │                               process, daily       │
│     │                               rotation ritual)     │
│     │                                     │ submit()     │
│     └────────onFinish()──────── job runner               │
│                                    │ spawn (minimal env) │
│                              worker claude sessions      │
│                              (builds, stories, research…)│
│                                                          │
│  scheduler: rotation @04:00 · reminders · poll/reconcile │
│  SQLite: sessions · jobs · reminders  (+ backup timer)   │
└──────────────────────────────────────────────────────────┘
   watchdog (separate systemd timer): health checks →
   Webex alert, email fallback (ADR 0005)
```

Module seams are the three frozen contracts:

| Contract | Seam |
|---|---|
| `webex-ingress` | Webex ⇄ transport: verification chain, InboundMessage, send() chunking |
| `assistant-session` | transport ⇄ session manager: relay(), rotation ritual, file layout |
| `job-lifecycle` | session manager ⇄ job runner: JobRecord, guarded state machine, completion sentinel, reconciliation |

## Transport: the front doors

Every door converts its wire format into the same frozen `InboundMessage`, awaits
`relay()` (`contracts/assistant-session.md`) itself, and owns delivery of its own
reply. All turns — whatever the door — queue on the ONE serialized relay chain and
land in the one shared conversational session. Ingress originally ran over a
cloudflared tunnel; ADR 0006 moved it to Tailscale Funnel **path scopes** — the
port is never Funneled wholesale.

| Door | Routes | Credential | Exposure | Contract |
|---|---|---|---|---|
| Webex | `POST /webhook` (+ loopback `GET /health`) | Webex HMAC signature + fetched-sender = owner | Funnel scope `/webhook` (ADR 0006) | `webex-ingress` |
| Control API | `/api/v1/*` | `NIGHTSHIFT_API_TOKEN` | loopback only — never Funneled | `control-api` |
| App transport | `/app/v1/*` (own server, port 3778) | `NIGHTSHIFT_APP_TOKEN` | loopback + tailnet IP only, never Funneled (ADR 0011) | `app-ingress` |
| **Hook ingress** | `POST /hook/v1/messages`, `GET /hook/v1/messages/<id>` | `NIGHTSHIFT_HOOK_TOKEN` | Funnel scope `/hook/v1` only (ADR 0018) | `hook-ingress` |

**Hook ingress — the third (public) chat door** (Stage 39, ADR 0018). A chat-only route
family on the daemon's existing loopback server for owner callers that are not on the
tailnet (curl, Shortcuts, Zapier/n8n). Dark by default: unless
`HOOK_INGRESS_ENABLED=true` the handler is never mounted and `/hook/v1/*` is the
server's plain 404, indistinguishable from any unknown path. Text in, text out: no
uploads, no file serving (reply files are only *counted* as `filesOmitted`), no MCP, no
job/UI endpoints. The reply goes to the caller only — synchronously when the turn
finishes inside a bounded wait (`HOOK_DEFAULT_WAIT_SEC`/`HOOK_MAX_WAIT_SEC`), otherwise
202 + a poll path backed by the durable `hook_messages` table (which is also the
idempotency record). Nothing is mirrored to Webex or the app outbox.

- **Trust level: owner-equivalent.** The hook token *is* the owner's password: a hook
  turn has the same power as the owner messaging the bot (including asking it to run
  jobs on the host). The daemon tags each turn `[via hook: <source>]` so the assistant
  knows its origin — a label, not a restriction. A leaked token is owner-equivalent
  compromise until it is rotated (one `.env` edit + restart; independent of the app and
  API tokens).
- **Fail closed, not enumerable.** Bearer auth with a constant-time compare (one shared
  helper, `src/transport/auth.ts`) runs before routing, so 401 precedes every
  404/405/400/413; flag on with the token unset ⇒ every hook route 401s and the daemon
  logs one startup error but keeps running.
- **Bounded.** Authenticated requests only are rate limited (POST token bucket
  `HOOK_RATE_PER_MIN`, burst 3; poll bucket `HOOK_POLL_RATE_PER_MIN`), and at most
  `HOOK_MAX_PENDING` hook turns may be pending — the relay queue is shared, so a flood
  must not stall the owner's Webex/app turns. Body ≤ 16 KiB, text ≤ 8000 chars.
- **Exposure is exactly one Funnel path scope**, `/hook/v1` → `127.0.0.1:3777/hook/v1`
  (provisioned in stage 40). `/api/v1/*`, `/app/v1/*` and `/health` must keep 404ing at
  the Funnel edge — verified by `docs/smoke/hook-ingress.md`.
- Logs carry messageId, source, status, latency and HTTP code only — never the token,
  the turn text, or the reply.

## Key design commitments

- **Fail-closed security** at the webhook (HMAC, fetched-sender auth, dedup); loopback
  bind; only Funnel path scopes are public (`/webhook`, and `/hook/v1` when the hook
  ingress is enabled — ADR 0018). Workers get a default-deny env allow-list — infra
  credentials never reach spawned sessions. Pre-push secret scan before any public
  GitHub push (capability-level, carried from the remediation plan).
- **State can't lie:** guarded transitions (terminal states are final), PID
  reconciliation each poll and at startup, bounded retries, explicit completion
  sentinels, scheduled SQLite backups. Each maps to a structural lesson in the vision doc.
- **Sessions:** one conversational session, rotated daily (04:00) or at a size cap;
  rotation writes a day summary to `logs/daily/`, promotes durable facts to `memory/`,
  archives the transcript. Long work NEVER runs in the conversational session.
- **Capabilities are skills:** the nsaf `skills/` monorepo remains the capability
  library, invoked by sessions. This repo contains the core only.

## Accepted drop-in feature: help agent (adapted)

The catalog's In-App Help Agent assumes a web UI; adapted here as a **restricted help
mode of the assistant session**: capability questions ("what can you do?", "how do I
make a story?") answered from a baked read-only snapshot of this repo's docs +
contracts + the skills catalog; draft-then-confirm GitHub issue filing for bugs; a
living FAQ (`docs/FAQ.md`) it reads and appends to. Least-privilege tool registry —
help mode gets read-only tools plus the issue-draft action, nothing else. Ships dark
behind `HELP_ENABLED`.

## Walking skeleton — Stage 0

The thinnest end-to-end slice; blocks all feature stages:

1. TypeScript daemon compiles; starts; applies migration 0001 (sessions/jobs tables);
   binds loopback; `/health` responds.
2. The full `webex-ingress` verification chain on `POST /webhook` (HMAC constant-time,
   fail closed, fetched-sender auth, messageId dedup).
3. relay(): a real resumable `claude` conversational session answers a message;
   reply chunked back through send().
4. **One real CI test suite** (green in GitHub Actions): forged/missing/unconfigured
   signature rejected; owner round-trip with the `claude` binary stubbed at the seam
   (`VERITY_AGENT_BIN`-style stub); guarded-transition helper rejects an illegal write.
5. **Deployed:** systemd unit + backup timer installed on the dev server by a deploy
   script; cloudflared route for `/webhook`; new Webex bot identity registered with
   its webhook secret.
6. **Smoke on live:** send "ping" from Webex, get a session-generated reply.

Explicitly OUT of Stage 0: job runner, rotation ritual, scheduler/watchdog, help mode,
any capability wiring. Those are feature stages riding the green spine.

## Feature stages after Stage 0 (input to /verity:plan)

Rough dependency order, for the planner to decompose:

1. **Rotation ritual** (daily + size-cap; summaries, memory promotion, archives)
2. **Job runner** (job-lifecycle contract: submit/kill/list, reconciliation, sentinels,
   minimal-env spawning) + completion notifications
3. **Scheduler + watchdog** (rotation trigger, reminders, heartbeat with email fallback)
4. **Capability wiring** (assistant session gets tools for: jobs, ideas-on-demand,
   app-build dispatch via SDD skills, story/study/brief dispatch, server ops)
5. **Deploy/promotion capability, simplified** (open question from vision doc:
   which of GitHub/Coolify/Cloudflare steps survive)
6. **Help mode** (adapted helper-bot, dark behind `HELP_ENABLED`)
7. **Transition & retirement** (parallel-run checklist, old-NSAF cutover)

Open questions carried to planning: Webex threads → sessions mapping; IPJ integration
surface; fate of old NSAF state (migrate vs read-only archive).
