# Stage 15: Build-gate cache clear must include the Astro 5 data store

- **Type:** bug
- **Depends on:** 13

## Objectives

Fix the second live promotion failure (2026-07-07 ~16:5x UTC): the build gate's
stale-cache retry cleared `<repo>/.astro` + `dist` (the old-NSAF reference's
locations), but Astro 5 keeps the content-layer data store in
`node_modules/.astro` — a stale store hides a freshly staged studyGuides entry,
the (exit-0) build renders no page for the new slug, and the gate correctly
refuses to push. Reproduced by hand on the host: identical staging built no
page until `node_modules/.astro` was removed, then rendered.

## What to build

Clear `node_modules/.astro` alongside `.astro`/`dist` in the retry (comment
cites the incident). Regression test via a `bun-stale-store` stub mode: while
`node_modules/.astro` exists the stub build renders nothing — old code fails,
new code passes on the retry and asserts exactly two builds ran.

## Acceptance conditions

- [ ] Reproduction captured + regression test (verified: fails on old code, passes on new)
- [ ] Existing suite stays green; CI all-green
- [ ] Frozen contracts untouched; no migration

## Pipeline test: NO
