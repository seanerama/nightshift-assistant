# Stage 13: Study promotion targets www/study-guides via the Astro website repo

- **Type:** bug
- **Depends on:** 11

## Objectives

Fix the mis-specified Stage 11 behavior caught at the dry-run gate (2026-07-07,
operator): study content must deploy INTO the existing Astro website at
`https://www.<NSAF_DOMAIN>/study-guides/<slug>` — not to a per-study subdomain.
Implement `contracts/site-promotion.md` v1 and route study content through it;
the subdomain pipeline remains, reserved for future APP promotion (unreachable
for study content after this fix).

**Reproduction:** `nightshift promote <study-output> --dry-run` planned
GitHub-repo + Coolify + subdomain steps for study content (recorded plan in the
stage trail); the correct target is the website flow the old NSAF `_promote_study`
implements.

## What to build

1. **Site pipeline** (`src/promotion/site.ts` + shared pieces): the contract's
   6 steps, ported from `~/projects/nsaf/flask-app/bot/commands.py`
   `_promote_study` (read from line 3502 to its end) and
   `~/projects/nsaf/deploy-study-guides.md` (dark-mode conversion procedure,
   YAML shape, textbook frontmatter). Reuse Stage 11's scan/store/record
   machinery; the record's steps array simply carries the site step names.
2. **Routing**: in the promote entry point, study-shaped content
   (guides/chapter-NN.html) → site pipeline; app-shaped content → the Stage 11
   subdomain pipeline (currently no validator admits apps — study content must
   never reach it). Story content: rejected with "story promotion not yet
   designed" (explicit, not accidental).
3. **Config**: `NIGHTSHIFT_WEBSITE_REPO` + `NIGHTSHIFT_BUN_PATH` (default `bun`)
   — documented; fail-fast when promote is enabled and the repo path is
   missing/not a git clone. (Names NIGHTSHIFT_-prefixed for the config
   contract; values on the host mirror NSAF_WEBSITE_REPO/BUN_PATH.)
4. **Safety on a shared repo**: `git pull --rebase` before staging; refuse on a
   dirty website repo (clear error naming the files); build must pass before
   commit/push.
5. **Dry run** shows the site plan (target URL, files to be written, yaml path).

## Interface contracts

- **Consumes:** `contracts/site-promotion.md` (implement exactly),
  promotion.md's record/store (shared shapes). No breaking edits; no migration
  (promotions table unchanged).

## Testing requirements

Fixture website repo (temp git repo with the Astro layout dirs + a stub
package.json whose build script is controllable) — never a real bun build in CI
(BUN seam: NIGHTSHIFT_BUN_PATH pointed at a stub).

- Routing: study content → site steps; story → explicit rejection; dry run
  side-effect-free with the site plan.
- Stage step: guides copied + dark-mode transformed (golden test on the CSS
  swap), YAML written with extracted chapter titles, textbook + frontmatter
  when present, idempotent re-promote.
- Dirty-repo refusal; build-failure aborts before push; push does pull --rebase.
- Health: bounded poll against a fixture target.
- **UI-smoke** (`docs/smoke/stage-13.md`): from Webex — "promote the subnetting
  study" → dry-run plan shows www/study-guides target → confirm →
  🚀 notice → open https://www.<domain>/study-guides/<slug>; verify the site's
  existing guides still render (shared-repo safety); re-promote idempotent.

## Acceptance conditions

- [ ] Reproduction captured + regression test (study content can never plan the
      subdomain pipeline)
- [ ] UI-smoke authored (docs/smoke/stage-13.md)
- [ ] No migration; frozen contracts untouched (site-promotion implements v1)
- [ ] Existing suite stays green; CI all-green
- [ ] `.env.example` covers the two new env reads

## Pipeline test: NO
