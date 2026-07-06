# Stage 1: Walking skeleton: verified Webex-to-Claude relay spine

- **Type:** feature
- **Depends on:** none

## Objectives

Prove the product's spine end-to-end with the thinnest honest slice: a Webex message
to the bot is HMAC-verified, relayed to a real resumable Claude Code session, and the
reply arrives back in Webex — built, tested, green in CI, and deployable to the dev
server under systemd. Blocks all feature stages (docs/ARCHITECTURE.md "Walking
skeleton — Stage 0"; this repo's stage numbering starts at 1, so Stage 1 IS the
walking skeleton).

## What to build

Per ADRs 0001–0004. Node LTS + TypeScript, pinned deps, committed lockfile.

1. **Daemon shell** (`src/`): starts, loads config from env (fail fast on missing
   `WEBEX_BOT_TOKEN` / `WEBEX_WEBHOOK_SECRET` / `WEBEX_OWNER_PERSON_ID`), binds
   **loopback only**, structured logs to stdout (journald picks them up).
2. **State bootstrap** (`src/db/`): better-sqlite3; migration ladder (`migrations/0001_*.sql`
   → `sessions`, `jobs` tables + schema-version row) applied at startup and by test
   fixtures; the **guarded-transition helper** (transition table per `contracts/job-lifecycle.md`;
   terminal states final; rejected transitions logged, not applied). The helper lands
   now so every later stage builds on it — no direct status writes anywhere.
3. **Transport** (`src/transport/`): `POST /webhook` implementing the full
   `contracts/webex-ingress.md` verification chain (raw-body HMAC-SHA1 constant-time
   vs `X-Spark-Signature`; fail closed when secret unset; authorize the FETCHED
   message's sender; `messageId` dedup; drop own messages; ack-then-work). `GET /health`.
   `send()` helper: markdown chunking that never splits a code fence; send-failure
   fallback message (never silent).
4. **Session manager, relay only** (`src/session/`): `relay(InboundMessage)` per
   `contracts/assistant-session.md` — create-or-resume the single conversational
   `claude` child session (headless JSON mode), serialize concurrent relays, return
   `AssistantReply`. Persist current session id in `sessions`. **No rotation ritual
   yet** (next stage); if the session dies mid-turn, reply with an error, never silence.
   The `claude` binary path comes from env (`NIGHTSHIFT_AGENT_BIN`, default `claude`)
   — this is the test seam.
5. **Ops artifacts** (`systemd/`): `nightshift-assistant.service` (Restart=on-failure,
   loopback env) + `nightshift-backup.service`/`.timer` (SQLite `VACUUM INTO` with
   retention, per ADR 0004). `.env.example` documenting every env var read (config
   contract: code reads nothing undocumented).
6. **CI gates** (edit `.github/workflows/ci.yml`, additive): node job — install
   (locked), typecheck, lint, `npm test`. Keep structure + gitleaks jobs.

## Interface contracts

- **Exposes:** the running spine every later stage extends — transport (`/webhook`,
  `/health`, `send()`), `relay()`, the migration ladder, the guarded-transition helper.
- **Consumes:** `contracts/webex-ingress.md`, `contracts/assistant-session.md` (relay
  surface only), `contracts/job-lifecycle.md` (state machine for the transition
  helper + `jobs` DDL). Frozen v1 — additive only; deviations are a planner round-trip,
  not an in-stage edit.

## Testing requirements

Real tests, no faked green (stub the agent binary at the seam, never the logic):

- **Signature chain:** forged signature → 401; missing header → 401; secret unset →
  ALL requests rejected; valid signature + non-owner fetched sender → 200-drop;
  valid + owner → processed. (Webex API stubbed with a local fixture server.)
- **Round-trip:** valid webhook → relay → stub `NIGHTSHIFT_AGENT_BIN` script emitting
  canned JSON → reply passed to a captured `send()`; duplicate `messageId` → no
  second execution.
- **Chunker:** over-cap markdown with code fences → fences never split.
- **Guarded transitions:** `running → succeeded` applies; `succeeded → running`
  rejected + logged; migration applies clean on a scratch DB twice (idempotent head).
- **UI-smoke asset** (for the Operator post-deploy): `docs/smoke/stage-1.md` — send
  "ping" to the new bot from Webex, expect a session-generated reply within 60s;
  `curl /health` on-host returns ok.

## Acceptance conditions

- [ ] Kill-switch: daemon refuses to start without explicit `NIGHTSHIFT_ENABLED=true`
      (the spine ships dark until the operator flips it on the host)
- [ ] UI-smoke "observably-works" check authored (`docs/smoke/stage-1.md`)
- [ ] Additive migration only (0001 creates; nothing destructive)
- [ ] Existing suite stays green; CI all-green (structure + gitleaks + new node job)
- [ ] No secret material in repo; `.env.example` covers every env read
- [ ] Operator prerequisite noted at PR: new Webex bot identity + webhook secret
      created (parallel-run identity, NOT the old NSAF bot's)

## Pipeline test: NO
