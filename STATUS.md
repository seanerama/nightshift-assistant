# Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`
> by the Release/Deploy Operator. Secret LOCATIONS only — never values.

**Live version:** 0.5.0
**Deployed at:** (not deployed)
**Rollback from:** v0.4.1 (git checkout + restart; migrations additive)

## Environments
- **prod:** {"tag":"v0.5.0","host":"dev server (nsaf-dev-server, user systemd)","webhook_url":"https://3090-tuf.taile0ffc4.ts.net/webhook","rotation":"enabled (NIGHTSHIFT_ROTATION_ENABLED=true); stage-2 smoke passed 2026-07-06","jobs":"enabled (NIGHTSHIFT_JOBS_ENABLED=true); stage-4 smoke passed 2026-07-06 (succeed + reconcile-adopt + kill + Webex notices)","stages":"1-10 live: spine, rotation, jobs, control API+CLI, type registry, acks, KillMode=process, delivery+formatted notices"}

## Secret locations (names + on-disk locations only, never values)
- WEBEX_BOT_TOKEN, WEBEX_WEBHOOK_SECRET, WEBEX_OWNER_PERSON_ID, NIGHTSHIFT_AGENT_BIN @ ~/apps/nightshift-assistant/.env on the dev server (mode 0600)

## Coordination notes
- (none)
