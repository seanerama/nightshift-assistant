# Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`
> by the Release/Deploy Operator. Secret LOCATIONS only — never values.

**Live version:** 0.9.1
**Deployed at:** 2026-07-22T13:29Z
**Rollback from:** v0.9.0 (git checkout + restart; migrations additive; db backup ~/backups/nightshift/nightshift-20260722-132802.db)

## Environments
- **prod:** {"tag":"v0.9.1","host":"dev server (nsaf-dev-server / 3090-tuf, user systemd)","webhook_url":"https://3090-tuf.taile0ffc4.ts.net/webhook","rotation":"enabled (NIGHTSHIFT_ROTATION_ENABLED=true); stage-2 smoke passed 2026-07-06","jobs":"enabled (NIGHTSHIFT_JOBS_ENABLED=true); stage-4 smoke passed 2026-07-06 (succeed + reconcile-adopt + kill + Webex notices)","stages":"1-18 live: spine, rotation, jobs, control API+CLI, type registry, acks, KillMode=process, delivery+formatted notices, content promotion (study + techguide), explicit models + dispatch honesty, study promotion → www/study-guides, sk- scanner fix, build-gate Astro 5 cache clear, guide job type (/tg pipeline), permission-reality preamble, techguide promotion → /guides, Perplexity MCP for pipeline workers","verified":"2026-07-22 13:35Z: v0.9.1 deployed, ACTIVE; #43 fixes verified in dist (all-tool denial finality + chat-grants-nothing + promotion-skill ban in preamble; marker-less techguide detection probe true); session rotated to 6864b5c6 with corrected seeds; netclaw-overview live (operator-promoted pre-fix)"}

## Secret locations (names + on-disk locations only, never values)
- WEBEX_BOT_TOKEN, WEBEX_WEBHOOK_SECRET, WEBEX_OWNER_PERSON_ID, NIGHTSHIFT_AGENT_BIN @ ~/apps/nightshift-assistant/.env on the dev server (mode 0600)

## Coordination notes
- open threads: issue #33 (study health-check soft-404); upstream tg-skill nondeterminism (techguide-config.json not always written — nsaf repo, outside this project; daemon now tolerates it)
