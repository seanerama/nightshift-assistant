# Stage 11: Content promotion: study/story to *.seanmahoney.ai via GitHub + Coolify + Cloudflare

- **Type:** feature
- **Depends on:** 10

## Objectives

Implement `contracts/promotion.md` v1 per ADR 0008: promote a content project
(study guides, story pages) from `~/projects/<dir>` to a live
`https://<slug>.<NSAF_DOMAIN>` through the proven GitHub → Coolify → Cloudflare
pipeline — as deterministic daemon code with a dry-run/confirm gate, a pre-push
secret scan, persisted PromotionRecords, and chat triggering via the existing
control surface. First real subject: the finished subnetting study.

## What to build

1. **Promotion module** (`src/promotion/`): the contract's 7-step pipeline,
   PORTED from the old NSAF reference implementation at
   `~/projects/nsaf/flask-app/bot/commands.py` (`cmd_promote`, `_promote_study`,
   `_add_cloudflare_tunnel_route` and the DNS helper — read them FIRST; they
   encode the working Coolify/CF API calls for this exact infrastructure).
   Each step records `{name, ok, detail}`; first failure stops and persists
   `failed` + error. Steps shell out to host `git`/`gh` for the repo step.
2. **Secret scan step**: filename deny-patterns (.env*, *.pem, *key*,
   credentials*, service-account*) + light content scan of text files (obvious
   token shapes). Any hit → abort BEFORE git init, listing the hits.
3. **Index generation**: study content (guides/*.html, textbook.md) without an
   index.html gets one generated (title + guide links + textbook link) — the
   promoted URL must land somewhere sensible.
4. **Persistence**: migration 0006 `promotions` table per the contract record.
   One live promotion per slug: re-promote updates in place (repo push, Coolify
   redeploy) rather than duplicating.
5. **API + CLI**: `POST /api/v1/promote` behind the existing control gates;
   `nightshift promote <path> [--slug] [--title] [--dry-run|--yes]`. Dry run is
   the default in BOTH; execution requires the explicit confirm.
6. **Config**: `NIGHTSHIFT_PROMOTE_ENABLED` (default OFF) + the ten consumed env
   names documented in `.env.example` (values live on the host only). Extend
   `workerEnv()` BLOCKED_PREFIXES with `CF_` and `COOLIFY_` (defense in depth).
7. **Session preamble**: promote exists; ALWAYS dry-run first, relay the plan,
   and only pass --yes after the operator explicitly confirms in chat.
8. **Notice**: completion (live URL) / failure through the Stage 10 notice
   builder (new 🚀 variant).

## Interface contracts

- **Consumes:** `contracts/promotion.md` (implement exactly), control-api gates,
  webex-ingress send(). Additive: control-api gains /api/v1/promote (additive
  evolution, recorded in the work item); migration 0006 additive.

## Testing requirements

External APIs stubbed at the seam (fixture HTTP servers for Coolify + Cloudflare,
a fake `gh`/`git` PATH shim for the repo step) — never stub the pipeline logic.

- Dry run: full step plan returned, ZERO side effects (no git dir, no fixture
  calls), record persisted as `planned`.
- Happy path: all 7 steps recorded ok; record `live` with repo/url; notice sent.
- Secret scan: seeded `.env`-like and key-like files abort before repo; hits listed.
- Validate: path outside $HOME/projects rejected; unrecognized content rejected;
  index.html generated when absent.
- Re-promote same slug: updates existing record/target, no duplicate.
- Step failure (fixture 500 at coolify): record `failed`, later steps not run,
  failure notice.
- Kill-switch off: endpoint + CLI refuse.
- Worker env: CF_/COOLIFY_ vars provably absent from workers (extend env-dump test).
- **UI-smoke** (`docs/smoke/stage-11.md`): on the host with real creds — dry-run
  the subnetting study via chat, confirm, watch the 7 steps, open the live URL;
  verify re-promote is idempotent; verify a worker env dump still lacks infra creds.

## Acceptance conditions

- [ ] Kill-switch: fully dark unless `NIGHTSHIFT_PROMOTE_ENABLED=true`
- [ ] UI-smoke authored (docs/smoke/stage-11.md)
- [ ] Additive migration only (0006)
- [ ] Existing suite stays green; CI all-green
- [ ] `.env.example` covers every new env read; no secret values in repo
- [ ] Frozen contracts untouched; dry-run-by-default proven by tests; secret-scan
      abort proven by tests

## Pipeline test: NO
