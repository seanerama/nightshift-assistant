# Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`
> by the Release/Deploy Operator. Secret LOCATIONS only — never values.

**Live version:** 0.12.2
**Deployed at:** 2026-07-25T03:40Z
**Rollback from:** v0.12.1 (git checkout + restart; migrations additive; db backup ~/backups/nightshift/nightshift-20260725-033547.db)

## Environments
- **prod:** {"tag":"v0.12.2","host":"dev server (nsaf-dev-server / 3090-tuf, user systemd)","webhook_url":"https://3090-tuf.taile0ffc4.ts.net/webhook","rotation":"enabled (NIGHTSHIFT_ROTATION_ENABLED=true); stage-2 smoke passed 2026-07-06","jobs":"enabled (NIGHTSHIFT_JOBS_ENABLED=true); stage-4 smoke passed 2026-07-06 (succeed + reconcile-adopt + kill + Webex notices)","remarkable":"PUSH enabled (NIGHTSHIFT_REMARKABLE_ENABLED=true, NIGHTSHIFT_REMARKABLE_FOLDER=/NS-Inbox, RMAPI_BIN=~/.local/bin/rmapi); stage-19 smoke passed 2026-07-25. INBOX live: note-ingest job type (stage 20) consumes notes the reMarkable /Outbound watcher submits — verified end-to-end 2026-07-25 (handwritten note → watcher → note-ingest worker → composed doc → /NS-Inbox).","job_timeout":"enabled (NIGHTSHIFT_JOB_TIMEOUT_MS default 2h; note-ingest 15m) — stage 21: a stalled `running` worker is killed + recorded `killed (timed out after Nm)` via the reconcile tick, restart-safe. Added after a note-ingest worker hung on a stalled model call.","stages":"1-23 live: … stage 23 adds URL HANDLING to the conversational preamble (URL work is dispatched to fetch-capable workers, never dead-ended)","verified":"2026-07-25 19:42Z: v0.12.2 deployed, ACTIVE; URL HANDLING line confirmed in dist; session rotated 51292b5e→de76f23a; seed audited — stale paste-belief confined to 2026-07-25.md (not seed material; latest is -2 stub + operator note). Webex smoke (docs/smoke/stage-23.md steps 2–4) PENDING OWNER — only the owner can message the bot"}

## Pending release — v0.13.0 (app transport; NOT deployed, NOT certified)
- **Stages 24–28 merged, CI-certified (zero skips):** `src/transport/app/` implements the full `agent-app-contract#v1.0.0` surface — manifest capabilities `["chat","files","mcp-tools","mcp-apps-ui"]`; the conformance harness gates CI. Everything ships DARK behind `APP_TRANSPORT_ENABLED` (default off; the flag is operator-set in the host .env only).
- **Stage 29 deploy config merged:** deploy.sh generates `NIGHTSHIFT_APP_TOKEN` on first enable (openssl rand -hex 32, appended to the host .env, never printed — same provisioning as `NIGHTSHIFT_API_TOKEN`, distinct value) and reports the app-transport bind/port; `APP_TRANSPORT_ENABLED` / `NIGHTSHIFT_APP_BIND` / `NIGHTSHIFT_APP_PORT` flow to the daemon via the units' existing `EnvironmentFile=.env`. No Funnel/cloudflared change — `/webhook` remains the only public route (ADR 0006/0011).
- **LIVE CERTIFICATION PENDING:** `docs/smoke/stage-29.md` is an UNFILLED evidence template (ss bind check, 401-precedes-404 from another tailnet machine, four-capability manifest, real SSE ack+reply, conformance exit 0 on prod, Webex dual-run, rollback drill, Funnel before/after, stage-27/28 smokes). Unfilled template = stage NOT certified; nothing here claims the surface works live.
- **Env-path discrepancy (2026-07-24):** `~/nightshift-assistant/.env` vs `~/apps/nightshift-assistant/.env` — resolution is step 0 of the stage-29 smoke; the confirmed path gets recorded there and here at cert time.
- **Owner Stage-0 exit — PENDING, owner-performed, not claimed:** chat with the assistant AND kill a real job from the Nightshift Client on the owner's phone. No agent may mark this done; only the owner's own run counts.

## Secret locations (names + on-disk locations only, never values)
- WEBEX_BOT_TOKEN, WEBEX_WEBHOOK_SECRET, WEBEX_OWNER_PERSON_ID, NIGHTSHIFT_AGENT_BIN @ ~/apps/nightshift-assistant/.env on the dev server (mode 0600)
- reMarkable cloud device token @ ~/.config/rmapi/rmapi.conf on the dev server (mode 0600) — used by RMAPI_BIN for the reMarkable PUSH capability; never in git, never in worker env

## Coordination notes
- open threads: issue #33 (study health-check soft-404); upstream tg-skill nondeterminism (techguide-config.json not always written — nsaf repo, outside this project; daemon now tolerates it)
