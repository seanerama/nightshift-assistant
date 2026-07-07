# Contract: site-promotion

- **Status:** frozen v1
- **Owner:** promotion module (daemon-resident; ADR 0008)

## Exposes

The WEBSITE pipeline behind the same control surface as `contracts/promotion.md`
(`POST /api/v1/promote` + `nightshift promote`) — study content routes HERE; the
subdomain pipeline in `promotion.md` is reserved for apps. Same request/record
shapes (PromotionRecord), same dry-run/confirm gating, same one-live-per-slug
semantics. Distinguishers: `url` is `https://www.<NSAF_DOMAIN>/study-guides/<slug>`
and `repoUrl` is the website repo.

## Consumes

- Env (daemon-only): `NSAF_WEBSITE_REPO` (local clone of the Astro site),
  `BUN_PATH` (default `bun`), `NSAF_DOMAIN`. The Coolify/CF vars are NOT used by
  this pipeline (hosting auto-deploys on push).
- Host `git`; the website repo's Astro layout (content collections
  `src/content/studyGuides/`, `src/content/textbooks/`; static
  `public/study-guides/<slug>/`).
- Reference implementation: old NSAF `_promote_study`
  (`flask-app/bot/commands.py`) + `deploy-study-guides.md` — port faithfully
  (dark-mode conversion, chapter-title extraction, YAML shape, textbook
  frontmatter).

## Schema / wire

**Pipeline (fixed order; each step recorded; first failure stops):**
1. **validate** — source is study output (`guides/chapter-NN.html` +
   `chapters/chapter-NN.md`; `textbook.md` optional); website repo exists and is
   a git clone; slug normalized (`[a-z0-9-]`).
2. **scan** — same secret scan as promotion.md, over the SOURCE content.
3. **stage** — copy guides into `public/study-guides/<slug>/` (dark-mode CSS
   conversion per the reference); write `src/content/studyGuides/<slug>.yaml`
   (title, chapter list with titles extracted from the markdown); textbook →
   `src/content/textbooks/<slug>.md` with frontmatter when present. Re-promote
   overwrites the same slug's files (idempotent).
4. **build** — `bun install --frozen-lockfile` (if needed) + the repo's build
   (e.g. `bun run build`) MUST pass locally before anything is pushed; a broken
   site never ships.
5. **push** — git add/commit/push on the website repo (pull --rebase first;
   the repo is shared with manual edits).
6. **health** — GET `https://www.<NSAF_DOMAIN>/study-guides/<slug>` (or the
   slug's YAML-driven page) until 200, bounded wait sized for the host's
   auto-deploy latency (default 20 × 15s).

**Gating:** identical to promotion.md — dry-run default, explicit confirm,
`NIGHTSHIFT_PROMOTE_ENABLED` kill-switch shared.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
