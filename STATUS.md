# Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`
> by the Release/Deploy Operator. Secret LOCATIONS only — never values.

**Live version:** 0.1.1
**Deployed at:** (not deployed)
**Rollback from:** v0.1.0 (git checkout v0.1.0 + restart; migrations additive so no schema rollback needed)

## Environments
- **prod:** {"tag":"v0.1.1","host":"dev server (nsaf-dev-server, user systemd)","webhook_url":"https://3090-tuf.taile0ffc4.ts.net/webhook","rotation":"enabled (NIGHTSHIFT_ROTATION_ENABLED=true); stage-2 smoke passed 2026-07-06"}

## Secret locations (names + on-disk locations only, never values)
- WEBEX_BOT_TOKEN, WEBEX_WEBHOOK_SECRET, WEBEX_OWNER_PERSON_ID, NIGHTSHIFT_AGENT_BIN @ ~/apps/nightshift-assistant/.env on the dev server (mode 0600)

## Coordination notes
- (none)
