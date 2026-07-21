# Status & Handoff

> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`
> by the Release/Deploy Operator. Secret LOCATIONS only — never values.

**Live version:** 0.8.0
**Deployed at:** 2026-07-18T21:33Z
**Rollback from:** v0.7.0 (git checkout + restart; migrations additive; db backup ~/backups/nightshift/nightshift-20260718-213029.db)

## Environments
- **prod:** {"tag":"v0.8.0","host":"dev server (nsaf-dev-server / 3090-tuf, user systemd)","webhook_url":"https://3090-tuf.taile0ffc4.ts.net/webhook","rotation":"enabled (NIGHTSHIFT_ROTATION_ENABLED=true); stage-2 smoke passed 2026-07-06","jobs":"enabled (NIGHTSHIFT_JOBS_ENABLED=true); stage-4 smoke passed 2026-07-06 (succeed + reconcile-adopt + kill + Webex notices)","stages":"1-17 live: spine, rotation, jobs, control API+CLI, type registry, acks, KillMode=process, delivery+formatted notices, content promotion (study + techguide), explicit models + dispatch honesty, study promotion → www/study-guides, sk- scanner fix, build-gate Astro 5 cache clear, guide job type (/tg pipeline), permission-reality preamble, techguide promotion → /guides","verified":"2026-07-18 21:35Z: v0.8.0 stage-17 UI-smoke PASSED — techguide promote 9b53ab10 (git-bisect-basics) dry-run planned correctly, executed live, daemon health content-asserted, journal 'site promotion live', independently verified live at /guides/git-bisect-basics.html with card on /guides listing"}

## Secret locations (names + on-disk locations only, never values)
- WEBEX_BOT_TOKEN, WEBEX_WEBHOOK_SECRET, WEBEX_OWNER_PERSON_ID, NIGHTSHIFT_AGENT_BIN @ ~/apps/nightshift-assistant/.env on the dev server (mode 0600)

## Coordination notes
- BLOCKED 2026-07-21: stage 18 (Perplexity MCP allow-rule, 95aa925) merged on main but NOT deployed — prod on v0.8.0; workstation tailnet link to 3090-tuf down (host itself up via funnel). On link restore: cut v0.9.0 or patch, deploy, run docs/smoke/stage-18.md (headless probe + research-citation check).
