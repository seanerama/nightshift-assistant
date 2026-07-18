# Stage 17: Techguide promotion: nightshift promote ships guide-shaped output to /guides

- **Type:** feature
- **Depends on:** 13,16

## Objectives

Close the promotion half of the guide pipeline (surfaced live 2026-07-18: the owner
asked the bot to promote the reMarkable techguide and `nightshift promote` correctly
rejected it as unrecognized — the promotion was then performed manually from the
workstation). After this stage, guide-job output promotes through the SAME daemon
pipeline, discipline, and credentials as study content: dry-run plan → explicit
confirm → scan → stage → build → push → content-asserting health check → 🚀 notice,
landing at `https://www.<NSAF_DOMAIN>/guides/<slug>`.

Explicitly NOT the bot's proposed alternative (a push-capable job type): ADR 0008
keeps promotion credentials daemon-only — workers never hold repo push rights.

## What to build

A TECHGUIDE route in the existing promotion module, mirroring the study route:

1. **Detection (route.ts)** — recognize techguide shape and route it to the website
   pipeline's new techguide path. Detection keys on the authoritative marker
   `techguide-config.json` at the content root AND `guide/index.html` present.
   **Techguide detection MUST run BEFORE study detection**: the tg skill is an sws
   fork and transient/residual sws artifacts (`chapters/`, `guides/`) have been
   observed in tg workdirs mid-run — study detection must never capture a techguide
   (misroute = wrong URL namespace + wrong YAML collection). Regression-test this
   precedence with a fixture holding BOTH markers.
2. **Staging (site.ts techguide path)** — port the canonical recipe
   (`deploy-technical-guide.md`, executed manually 2026-07-18 for
   `remarkable-paper-pro` — use that commit `2ba563e` in the website repo as the
   reference output):
   - Layout detect from `guide/`: `index.html` only → SINGLE PAGE, copy to
     `public/guides/<slug>.html`; `index.html` + `section-NN*.html` → HUB, copy all
     to `public/guides/<slug>/`. Any other shape → validate error, do not guess.
   - Content entry `src/content/guides/<slug>.yaml` (schema: title, slug,
     description, htmlFile, order — all required). Title from the guide's
     `<title>`; description from `techguide-config.json` when present, else
     generated. `htmlFile`: `<slug>.html` or `<slug>/index.html`.
   - **Order allocation:** next free `order` scanned from existing
     `src/content/guides/*.yaml`; on RE-promote of an existing slug, KEEP the
     existing entry's order (idempotency — `remarkable-paper-pro.yaml` with
     order 7 already exists from the manual run and must survive a re-promote
     unchanged in position).
   - Dark-mode conversion ONLY if the HTML carries the standard light palette
     (`--color-bg: #fafafa`); tg output is dark-native — "don't fight a design it
     already has" (recipe step 3).
3. **Shared steps reused verbatim** — secret scan over the source; build gate with
   the stage-15 cache clear (`.astro`, `node_modules/.astro`, `dist`) and bun-only
   discipline; `pull --rebase` + push; promotions store one-live-per-slug.
4. **Health check (techguide)** — MUST assert content, not status: GET the live URL
   FOLLOWING REDIRECTS (Cloudflare Pages 308s `.html`/`index.html` to clean URLs —
   observed live 2026-07-18) and match the staged guide `<title>`. A bare 200 is
   meaningless here: the host serves a 200 fallback page for unknown paths (the
   soft-404 trap of issue #33). Do not fix the STUDY health check in this stage —
   that is #33's own scope — but the techguide check is born content-asserting.
5. **Session awareness** — extend `PROMOTE_PREAMBLE` (manager.ts): techguide
   content now promotes to `/guides/<slug>`; story remains rejected. Update the
   preamble pins in test/control.test.ts accordingly.

## Interface contracts

- **Exposes:** techguide routing on the existing promote surface
  (`POST /api/v1/promote` + `nightshift promote`), same PromotionRecord/dry-run/
  confirm shapes; `url` distinguisher `https://www.<NSAF_DOMAIN>/guides/<slug>`.
- **Consumes:** `contracts/site-promotion.md` v1.1 — ADDITIVE amendment (this
  plan adds the Techguide-shape section; the contract is frozen additive-only and
  this is the same seam with a new content shape, verified: no consumer breaks).
  Website repo layout: `src/content/guides/` collection + `public/guides/`
  (verified live in the repo, wired via `src/pages/guides.astro` — no page code
  needed). Daemon env already present from stage 13: `NSAF_WEBSITE_REPO`,
  `BUN_PATH`, `NSAF_DOMAIN`.

## Testing requirements

- Unit: detection precedence (techguide marker beats residual sws dirs; study-only
  fixtures still route study; neither → unrecognized message now naming both
  accepted shapes); layout detect (single vs hub vs malformed); YAML generation
  (schema fields, order = max+1, re-promote keeps existing order); dark-mode guard
  (light palette converted, dark-native untouched).
- Integration (test/promotion-site.test.ts pattern, temp git remote): full
  techguide dry-run plan shape; confirmed promote stages/builds/pushes the fixture
  hub into a scratch website repo; idempotent re-promote; health step retries then
  succeeds only when the fetched body carries the staged title (stub fetch: assert
  a soft-404 200 body does NOT pass).
- Preamble pins for the PROMOTE_PREAMBLE addition.

## Acceptance conditions

- [ ] Kill-switch: shared `NIGHTSHIFT_PROMOTE_ENABLED` gate (identical gating is a
      frozen property of the site-promotion contract; no new flag — record rationale
      in the PR).
- [ ] UI-smoke authored (`docs/smoke/stage-17.md`): live-promote the EXISTING
      git-bisect-basics guide from the prod host (`~/projects/git-bisect-basics/
      output/git-bisect-basics/`), dry-run relayed → confirm → 🚀 notice →
      content-asserted live at `/guides/git-bisect-basics`.
- [ ] Additive migration only (promotions store schema unchanged; contract amended
      additively to v1.1).
- [ ] Existing suite stays green; CI all-green.

## Out of scope (explicit)

- Issue #33 (study health-check soft-404 fix) — separate bug; this stage only
  makes the NEW check content-asserting.
- `website-state.md` upkeep (manual lore doc outside both repos) — remains the
  operator's; the 🚀 notice gives them the trigger.
- Story promotion (still explicitly rejected).

## Pipeline test: NO
