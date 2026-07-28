# Stage 38: Authoring fidelity: iterate from installed HTML, teach state-aware pages

- **Type:** chore
- **Depends on:** 36,37
- **Design:** ADR 0016 (state pattern) · observed defect: DoD step-2 run
  2026-07-28 — v2 regenerated from memory; owner's UI-added data lost (see
  feature-assessments/generative-ui-assessment.md §Stage-37/38 addendum).
  Issue #85.

## Objectives

The assistant iterates pages without losing anything: it starts each new
version from the CURRENTLY INSTALLED HTML (not from memory), and it builds
pages that hold user data as state-tool users (ADR 0016) so data survives
versions by construction. Preamble-only stage — no daemon/CLI code.

## What to build

`GENERATIVE_UI_PREAMBLE` (src/session/manager.ts) — two edits:

1. **ITERATION FIDELITY (new hard rule, extends REUSE FIRST):** before
   authoring version N+1, fetch the active version's exact HTML —
   `nightshift ui show <name> <version> --json` — and EDIT it; never
   regenerate a page from memory. Owner-visible content and wiring must
   carry forward unless the owner asked for its removal.
2. **STATE (new block, after AUTHORING RULES):** pages that hold user data
   (trackers, lists, form input) MUST persist through the state tools:
   request `ui_state_get,ui_state_set` at install, load state on
   `ui/ready` via `ui_state_get`, write back on every user mutation via
   `ui_state_set` (full-document replace, ≤64 KB), and render degradably
   when the tools are ungranted (the zero-trust default). The grant ask in
   chat must say plainly that v1 state tools are namespace-wide ("this page
   could read/write other pages' saved data — allow?" — ADR 0016 caveat).
   Purely presentational pages must NOT request state tools.

## Interface contracts

- **Exposes:** nothing on the wire — preamble text only.
- **Consumes:** contracts/ui-state.md v1 (tool names/shapes quoted must
  match), contracts/generative-ui.md (verb family), bin/nightshift USAGE
  (drift detector governs).

## Testing requirements

- test/control.test.ts: extend the pinned-discipline test — preamble MUST
  contain the `ui show <name>` fetch-before-iterate instruction, `ui_state_get`
  and `ui_state_set`, the namespace-wide grant-ask wording, and the
  degradable-when-ungranted rule; MUST still not contain "temp file". The
  verb/flag drift detector must cover the new `ui state` verb references.
- Full suite green; harness green both flag states (no transport changes).
- docs/smoke/generative-ui.md: append DoD step 2' — iterate a state-holding
  page and confirm the data survives the version bump (the exact failure the
  owner hit, now the regression check).

## Acceptance conditions

- [ ] Exit state documented above achieved (fidelity + state blocks live in
      the preamble; pins green)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
