# Stage 14: Secret-scan precision: kebab-case anchors are not API keys

- **Type:** bug
- **Depends on:** 13

## Objectives

Fix the live-found scanner false positive that aborted the first real site
promotion (2026-07-07 16:36 UTC): the `sk-` content pattern's tail allowed
hyphens (`[A-Za-z0-9_-]{32,}`), so the study's own kebab-case heading anchors
(`sk-cheat-sheet`, `sk-comparison-subnet-versus-wildcard`, 8 files flagged)
matched. The scan correctly aborted before any repo write — right behavior,
wrong trigger. Real sk- keys are long UNBROKEN alphanumeric runs.

## What to build

Tighten the pattern to `sk-(?:proj-|ant-)?[A-Za-z0-9_]{20,}` (no hyphen in the
run) with a comment citing the incident. Regression tests: the live incident's
anchor strings must NOT match; realistic key shapes (sk-<40 alnum>,
sk-proj-<32 alnum>) MUST.

## Acceptance conditions

- [ ] Reproduction captured + regression test (fails before, passes after)
- [ ] Existing suite stays green; CI all-green
- [ ] Frozen contracts untouched; no migration

## Pipeline test: NO
