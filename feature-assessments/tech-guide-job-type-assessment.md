# Assessment: Tech-guide job type (`guide`)

- **Request origin:** issue #35 (2026-07-18 live failure) — secondary gap flagged
  during the Tester's root-cause: no dispatch target for tech-guide asks, which
  invited the conversational session to run the /tg pipeline inline and dead-end on
  terminal permission denials. The behavioral half (denial finality) is PR #36; this
  assessment covers the capability half.
- **Decision:** ACCEPT as Stage 16 (single stage — one registry entry + tests; no
  split needed).

## Claim / reality table (verified 2026-07-18)

| Claim | Reality |
|---|---|
| No tech-guide job type exists | Confirmed — registry in `src/jobs/types.ts` is generic/story/study/brief/app-build |
| tg skill is installed on the prod host | Confirmed — `~/.claude/commands/tg/*.md` + `~/.claude/tg/{bin,prompts,references,templates}` on 3090-tuf |
| tg pipeline shape | start auto-chains scope → research → write → diagrams → build; variants deep/comparison/explainer (default deep); no slides/podcast/quizzes; output at `output/<slug>/guide/` (per the TECHGUIDE OVERLAY in `tg/commands/start.md`) |
| Existing pipeline permission profile suffices | Confirmed — tg helpers are `node "$HOME/.claude/tg/bin/sws-tools.cjs"` and `curl`, covered by `Bash(node *)`/`Bash(curl *)` in `PIPELINE_PERMISSION_ARGS` |
| Env needs | `PERPLEXITY_API_KEY` (tg research is the sws fork; Perplexity referenced in start.md + research.md) — same extraEnv as study/brief |
| Contract safety | `contracts/job-lifecycle.md` declares `type` an open set — additive; `control-api.md` does not enumerate types |
| Session discoverability | `jobTypesPreamble()` renders from the registry — new type advertised to new sessions with zero session-code change |

## Why `guide` and not reusing `study`

The study type would *approximately* serve (it built the ReMarkable ask's nearest
substitute), but it produces the SWS shape (textbook + quizzes + per-chapter guides)
and promotes to `/study-guides/`. The tg skill is a deliberate fork with different
output contract (single `guide/` dir, variants, no quizzes, dark theme). Mapping tech
asks onto study would misrepresent what the owner receives. The registry exists to
make each pipeline's posture explicit — one entry is the cheap, honest fix.

## Alternatives considered

- **Preamble-only redirect to `study`:** zero code, but produces the wrong artifact
  shape for comparison/explainer asks; rejected.
- **Generic-type submit with a /tg instruction:** workers spawn near-zero-permission;
  the pipeline's helper calls would be denied — same failure moved into the worker;
  rejected.

## Deferred

- Tech-guide site promotion (extend `site-promotion.md` routing to the tg output
  shape) — future stage, only worth planning once guides are being produced.
- New job types are dark behind the existing `NIGHTSHIFT_TYPES_ENABLED` kill-switch;
  no new flag.
