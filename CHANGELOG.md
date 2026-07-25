# Changelog

## 0.12.2

### Other
- [stage 23] Assistant dead-ends on a URL instead of dispatching it to a worker that can fetch (#58)
- ops: v0.12.1 live — note-ingest runs without Perplexity MCP (smoke confirmed)

## 0.9.1

### Fixes
- promote-skill dead-end + brittle techguide marker detection (#43) (#44)

### Other
- Plan: site-promotion v1.2 — techguide detection keys on the artifact, marker optional (#43)
- ship: v0.9.0 smoke verified — Perplexity MCP research live in headless pipelines (job 742477ad)
- ship: v0.9.0 — Perplexity MCP for pipeline workers; probe verified on host (job 742477ad in flight)

## 0.9.0

### Other
- ops: stage 18 merged, ship blocked on workstation tailnet link (note in STATUS)
- [stage 18] Pipeline workers may call the Perplexity MCP server (#41) (#42)
- Plan: Stage 18 spec — Perplexity MCP allow-rule for pipeline workers (#41)
- ship: v0.8.0 — techguide promotion live, stage-17 smoke verified (promotion 9b53ab10)

## 0.8.0

### Other
- [stage 17] Techguide promotion: nightshift promote ships guide-shaped output to /guides (#39) (#40)
- Plan: Stage 17 spec — techguide promotion route + site-promotion contract v1.1 (#39)
- ship: v0.7.0 smoke verified — guide pipeline green on live (job 0025de85)
- ship: v0.7.0 — changelog + runtime truth (deployed 2026-07-18T19:35Z)

## 0.7.0

### Fixes
- preamble teaches denial finality — headless approvals cannot resolve (#35) (#36)

### Chores
- commit v0.6.3 runtime truth left uncommitted by the previous ship
- jobs run in sequence by default — NIGHTSHIFT_MAX_JOBS 2 → 1 (#34)

### Other
- [stage 16] Tech-guide job type: dispatchable /tg pipeline (#37) (#38)
- Plan: Stage 16 spec — tech-guide job type (guide) for the /tg pipeline (#37)

## 0.6.3

### Other
- [stage 15] Build-gate cache clear must include the Astro 5 data store (#32)

## 0.6.2

### Other
- Stage 14: sk- scanner pattern requires unbroken runs — kebab anchors are not keys (#29)

## 0.6.1

### Other
- [stage 13] Study promotion targets www/study-guides via the Astro website repo (#27)
- Plan: site-promotion contract v1 + Stage 13 spec (study promotion → website repo)

## 0.6.0

### Other
- [stage 12] Explicit models, CLI-spelling allowances, dispatch honesty (#24)
- Plan: Stage 12 spec — explicit models, CLI spellings, dispatch honesty
- [stage 11] Content promotion: study/story to *.seanmahoney.ai via GitHub + Coolify + Cloudflare (#23)
- Plan: ADR 0008, promotion contract v1, Stage 11 spec (content promotion)
- Ship v0.5.0: STATUS — delivery polish live

## 0.5.0

### Other
- [stage 10] Delivery polish: Webex file attachments + formatted notices (#20)

## 0.4.0

### Other
- [stage 8] Ack-first: immediate receipt signal for slow turns (#16)
- Plan: Stage 8 spec — ack-first receipt for slow turns

## 0.3.1

### Fixes
- prepend <appDir>/bin to the conversational session PATH (control-gated) (#14)

### Other
- Plan: Stage 7 bug spec — session PATH for the nightshift CLI

## 0.3.0

### Other
- [stage 6] Job-type registry: skill payloads with per-type permission profiles (#12)
- [stage 5] Control API + nightshift CLI: assistant session gets job/rotation/status tools (#11)
- Plan: control-api contract, ADR 0007, Stage 5+6 specs (capability wiring)
- Ship v0.2.0: STATUS — job runner live, stage-4 smoke passed

## 0.2.0

### Other
- [stage 4] Job runner: minimal-env worker sessions, reconciliation, sentinels, finish notices (#8)
- Plan: Stage 4 spec (job runner) + assessment
- Ship v0.1.1: STATUS — rotation live, stage-2 smoke passed

## 0.1.1

### Fixes
- pending-session detection is an explicit marker, not turns==0 (#6)

### Other
- Plan: Stage 3 bug spec — explicit pending-session marker

## 0.1.0

### Other
- [stage 2] Rotation ritual: daily summary, memory promotion, seeded fresh sessions (#4)
- Plan: Stage 2 spec (rotation ritual) + assessment
- Ship v0.0.1: STATUS runtime truth + ADR 0006 (Tailscale Funnel ingress)
- Ship: deploy.sh fixes — bootstrap into existing dir, drop invalid npm flag

## 0.0.1

### Other
- Ship: deploy.sh — bare-metal user-systemd deploy to the dev server, dark-safe
- [stage 1] Walking skeleton: verified Webex-to-Claude relay spine (#2)
- Plan: Stage 1 spec (walking skeleton) + assessment
- Architect: ADRs 0001-0005, frozen contracts v1, architecture + walking skeleton
- Initial commit — scaffolded by Verity
