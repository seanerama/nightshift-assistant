# Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`
> by the Release/Deploy Operator. Secret LOCATIONS only — never values.

**Live version:** 0.16.0
**Deployed at:** 2026-10-17T04:01Z
**Rollback from:** v0.15.0 (tag) + DB backup ~/backups/nightshift/nightshift-20261017-035748-pre-v0.16.0.db + .env backup env-20261017-035748-pre-v0.16.0 on host

## Environments
- **prod:** {"tag":"v0.16.0","host":"dev server (nsaf-dev-server / 3090-tuf, user systemd)","webhook_url":"https://3090-tuf.taile0ffc4.ts.net/webhook (Webex) + https://3090-tuf.taile0ffc4.ts.net/hook/v1 (hook ingress, ADR 0018)","rotation":"enabled (NIGHTSHIFT_ROTATION_ENABLED=true); stage-2 smoke passed 2026-07-06","jobs":"enabled (NIGHTSHIFT_JOBS_ENABLED=true); stage-4 smoke passed 2026-07-06 (succeed + reconcile-adopt + kill + Webex notices)","remarkable":"PUSH enabled (NIGHTSHIFT_REMARKABLE_ENABLED=true, NIGHTSHIFT_REMARKABLE_FOLDER=/NS-Inbox, RMAPI_BIN=~/.local/bin/rmapi); stage-19 smoke passed 2026-07-25. INBOX live: note-ingest job type (stage 20) consumes notes the reMarkable /Outbound watcher submits — verified end-to-end 2026-07-25 (handwritten note → watcher → note-ingest worker → composed doc → /NS-Inbox).","job_timeout":"enabled (NIGHTSHIFT_JOB_TIMEOUT_MS default 2h; note-ingest 15m) — stage 21: a stalled `running` worker is killed + recorded `killed (timed out after Nm)` via the reconcile tick, restart-safe. Added after a note-ingest worker hung on a stalled model call.","stages":"1-23 live: … stage 23 adds URL HANDLING to the conversational preamble (URL work is dispatched to fetch-capable workers, never dead-ended)","verified":"2026-07-25 19:42Z: v0.12.2 deployed, ACTIVE; URL HANDLING line confirmed in dist; session rotated 51292b5e→de76f23a; seed audited — stale paste-belief confined to 2026-07-25.md (not seed material; latest is -2 stub + operator note). Webex smoke (docs/smoke/stage-23.md steps 2–4) PENDING OWNER — only the owner can message the bot","commit":"15a63ae","generative_ui":"v0.15.0 live 2026-07-28: ui-state store + authoring fidelity — schema 10, 7-tool catalog verified, CLI-seeded state read via ui_state_get MCP call, session rotated (c01cc192, stage-38 preamble); harness 22/23 warm (files.roundtrip = known flake); owner smoke 2'+3 pending (state-holding tracker + grant conversation)","hook_ingress":"v0.16.0 2026-10-17: LIVE + PUBLIC at https://3090-tuf.taile0ffc4.ts.net/hook/v1 (Funnel 443 path scope -> 127.0.0.1:3777/hook/v1; briefly on :10000, moved back because the assistant's network allows only outbound 443; :10000 OFF). Edge-verified off-tailnet: 401 unauth, authenticated 200 sync, /api/v1 /app/v1 /health 404. Rollback: tailscale funnel --set-path /hook/v1 off (NEVER --https=443 off). Webex round-trip smoke (step 7) PENDING OWNER. See docs/smoke/hook-ingress.md."}

## Secret locations (names + on-disk locations only, never values)
- WEBEX_BOT_TOKEN, WEBEX_WEBHOOK_SECRET, WEBEX_OWNER_PERSON_ID, NIGHTSHIFT_AGENT_BIN @ ~/apps/nightshift-assistant/.env on the dev server (mode 0600)
- reMarkable cloud device token @ ~/.config/rmapi/rmapi.conf on the dev server (mode 0600) — used by RMAPI_BIN for the reMarkable PUSH capability; never in git, never in worker env
- NIGHTSHIFT_HOOK_TOKEN @ ~/apps/nightshift-assistant/.env on the dev server (mode 0600)

## Coordination notes
- open threads: issue #33 (study health-check soft-404); upstream tg-skill nondeterminism (techguide-config.json not always written — nsaf repo, outside this project; daemon now tolerates it)
