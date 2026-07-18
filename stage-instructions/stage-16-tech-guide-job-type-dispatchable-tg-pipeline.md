# Stage 16: Tech-guide job type: dispatchable /tg pipeline

- **Type:** feature
- **Depends on:** 6

## Objectives

Close the capability gap behind the 2026-07-18 live failure (issue #35): "build me a
tech guide"-shaped asks had no dispatch target, so the conversational session
improvised the /tg pipeline inline and dead-ended on terminal permission denials.
After this stage, `nightshift submit --type guide --params '{"topic": "..."}'`
dispatches the Techguide pipeline as a normal background job, and the session's
capability preamble advertises it automatically.

## What to build

One additive registry entry in `src/jobs/types.ts` (nothing else in the runner needs
to change — the registry IS the seam; Stage 6 built it for exactly this):

- **type:** `guide`
- **experimental:** false
- **usage:** `guide — interactive tech guide via the /tg:* Techguide pipeline; params {"topic": "...", "variant"?: "deep" | "comparison" | "explainer"}`
- **params:** `topic` required non-empty string; `variant` optional, MUST validate
  against the closed set `{deep, comparison, explainer}` (JobTypeError otherwise);
  omitted → the skill's own default (`deep`) — do not inject a default, let the
  skill own it.
- **instructionTemplate:** `/tg:start <topic>`, plus (when `variant` given) a line
  directing that variant, plus: "Run the Techguide pipeline to completion
  (scope → research → write → diagrams → build) for this topic." + the shared
  `AUTONOMY_NOTE`. Pipeline shape verified against the installed skill
  (`~/.claude/commands/tg/start.md`): start auto-chains scope → research → write →
  diagrams → build; NO slides/podcast/quizzes; output lands at `output/<slug>/guide/`.
- **workdirStrategy:** `~/projects/<slugify(topic)>` (same as study).
- **titleTemplate:** `Guide: <truncate(topic)>` (variant suffix ` (comparison)` /
  ` (explainer)` when given).
- **permissionArgs:** the existing `PIPELINE_PERMISSION_ARGS` — verified sufficient:
  the tg helpers are `node "$HOME/.claude/tg/bin/sws-tools.cjs"` and `curl`, both
  covered by `Bash(node *)` / `Bash(curl *)`; file writes are in-workdir under
  acceptEdits.
- **extraEnv:** `['PERPLEXITY_API_KEY']` — tg research is the sws fork and fans out
  through Perplexity (verified in `tg/commands/research.md` + `start.md`).
- **model:** `WORKER_MODEL_HEAVY` (content pipeline, same tier as story/study/brief).

No preamble edit needed: `jobTypesPreamble()` renders from the registry, so the new
usage line reaches new sessions automatically. No CLI change: `nightshift submit
--type` passes type strings through verbatim.

## Interface contracts

- **Exposes:** job type `guide` on the existing typed-submit surface
  (`POST /control/jobs` / `nightshift submit --type`).
- **Consumes:** `contracts/job-lifecycle.md` — the `type` field is declared an OPEN
  SET, so this is additive and contract-safe (verified line 12). `contracts/control-api.md`
  does not enumerate types. The host-resolved skill seam from Stage 6: `/tg:*`
  commands + `~/.claude/tg/` data dir VERIFIED present on the prod host (2026-07-18).

## Testing requirements

- Unit (test/types.test.ts pattern): render pins for `guide` — instruction contains
  `/tg:start`, workdir slug, title prefix, `PIPELINE_PERMISSION_ARGS` identity,
  extraEnv exactly `['PERPLEXITY_API_KEY']`, model = heavy; `variant` validation
  (each valid value renders, an invalid value → JobTypeError, omitted → no variant
  line in the instruction).
- Integration (test/jobs.test.ts pattern): `submitType('guide', …)` spawns with the
  pipeline permission args + heavy model, and writes the `job-type.txt` marker.
- Preamble: `jobTypesPreamble()` contains the `guide` usage line.
- Stage 6-style host smoke (manual, recorded in the PR): `/tg:*` resolvable on the
  prod host.

## Acceptance conditions

- [ ] Kill-switch: covered by the EXISTING `NIGHTSHIFT_TYPES_ENABLED` gate (Stage 6)
      — all non-generic typed submits are dark when it is off; no new flag needed
      (record this as the flag rationale in the PR).
- [ ] UI-smoke "observably-works" check authored: one live `nightshift submit --type
      guide` on a small topic reaches `succeeded` with `output/<slug>/guide/` populated.
- [ ] Additive migration only — no schema change at all (registry + tests only).
- [ ] Existing suite stays green; CI all-green.

## Out of scope (explicit)

- Promoting tech guides to the website: `nightshift promote` detection targets the
  study shape (`guides/` + textbook); tg's `output/<slug>/guide/` will be rejected as
  unrecognized, which is correct-but-unsupported for now. Site promotion for tech
  guides is its own future stage against `contracts/site-promotion.md`.
- The /tg skill itself (owned outside this repo; resolved from the host per Stage 6).

## Pipeline test: NO
