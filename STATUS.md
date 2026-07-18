# Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`
> by the Release/Deploy Operator. Secret LOCATIONS only — never values.

**Live version:** 0.6.3
**Deployed at:** 2026-07-07T16:59Z
**Rollback from:** v0.6.2 (git checkout + restart; migrations additive)

## Environments
- **prod:** {"tag":"v0.6.3","host":"dev server (nsaf-dev-server / 3090-tuf, user systemd)","webhook_url":"https://3090-tuf.taile0ffc4.ts.net/webhook","rotation":"enabled (NIGHTSHIFT_ROTATION_ENABLED=true); stage-2 smoke passed 2026-07-06","jobs":"enabled (NIGHTSHIFT_JOBS_ENABLED=true); stage-4 smoke passed 2026-07-06 (succeed + reconcile-adopt + kill + Webex notices)","stages":"1-15 live: spine, rotation, jobs, control API+CLI, type registry, acks, KillMode=process, delivery+formatted notices, content promotion (study/story → seanmahoney.ai), explicit models + dispatch honesty, study promotion → www/study-guides, sk- scanner fix, build-gate Astro 5 data-store cache clear","verified":"2026-07-12: service active on host (up since 18:14 UTC), NIGHTSHIFT_ENABLED=true, backup timer active"}

## Secret locations (names + on-disk locations only, never values)
- WEBEX_BOT_TOKEN, WEBEX_WEBHOOK_SECRET, WEBEX_OWNER_PERSON_ID, NIGHTSHIFT_AGENT_BIN @ ~/apps/nightshift-assistant/.env on the dev server (mode 0600)

## Coordination notes
- 483f539 (chore: NIGHTSHIFT_MAX_JOBS 2 → 1, #34) is on main but not yet tagged/deployed
