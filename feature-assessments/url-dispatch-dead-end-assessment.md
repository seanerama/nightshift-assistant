# Intake assessment: assistant dead-ends on a URL (stage 23, bug)

- **Reported:** 2026-07-25 by the owner — a Webex turn failed its purpose: an x.com
  link + "build a deep-dive techguide" got back "I can't fetch that link… paste the
  text" instead of a dispatched guide job.
- **Decision:** **ACCEPT** as one bug stage (23). No split — the fix is one preamble
  line plus its test and smoke.

## Verification against the live codebase (v0.12.1, main @ 94e5c12)

| Claim | Reality | Verdict |
|---|---|---|
| The WebFetch denial was real | Conversational grant is exactly `NIGHTSHIFT_TOOL_RULE` = three spellings of the nightshift CLI (`src/session/manager.ts:69`); `WebFetch` appears in exactly one place in the codebase — `PIPELINE_ALLOWED_TOOLS` (`src/jobs/types.ts:181`) | ✅ correct denial, correct non-retry (#43 behavior working as designed) |
| The worker could have done it | `guide` type → `permissionArgs: PIPELINE_PERMISSION_ARGS` → `WebFetch WebSearch mcp__perplexity` + scoped Bash | ✅ capability exists one dispatch away |
| A URL fits the job payload | `guide` params = `{topic: string, variant?}`; typed submit is `nightshift submit --type <type> --params '<json>'` (`bin/nightshift:25`, `jobTypesPreamble()` at `src/jobs/types.ts:553` advertises exactly this) | ✅ no code change needed to accept a URL |
| The preamble never covers links | Read `CONTROL_PREAMBLE` in full: CLI surface, dispatch honesty, permission reality, `--json`, don't-poll. No mention of URLs or of workers' research tools | ✅ root cause confirmed — briefing gap |
| A preamble edit is low-risk | `test/control.test.ts` asserts containment/ordering of the **constant**, not copied text; preamble applied only to NEW sessions (`manager.ts:442`) | ✅ tests survive; ⚠️ live effect requires rotation — smoke must rotate first |
| Same failure class as before | #22 (path spellings), #35 (permission dead-end), #41 (silent WebSearch fallback): all "code right, session briefing incomplete," all fixed at the preamble/allow-rule layer | ✅ house precedent for exactly this fix shape |

## The alternative rejected, and why

**Grant the conversational session `WebFetch`.** It would make the observed turn
succeed and is a one-line change. Rejected: that session holds the control token
(`nightshift submit`/`deliver`/`promote` surface) — arbitrary web content flowing
straight into it is the prompt-injection vector the deliver-root confinement and the
minimal grant exist to bound. The asymmetry (chat can't fetch, workers can) is the
security design; the fix is to make the session *understand* the asymmetry instead of
being defeated by it. Also honest: for the actual trigger (an X post) inline WebFetch
would likely have failed anyway — X blocks server-side fetches — while the worker's
Perplexity seam is the plausible path.

**Also rejected:** teaching only the `guide` builder about URLs (`buildInstruction`
tweak) — the gap is generic across research/study/brief dispatch, and the decision
point is the session, not the worker.

## Risk register

1. **Preamble bloat.** The briefing is now ~13 dense lines; each addition dilutes the
   rest. Accepted for one line; if another briefing bug lands after this, the *next*
   stage should restructure the preamble rather than append again.
2. **Inert-until-rotation.** A deployed fix that changes nothing until 04:00 invites a
   false "verified" — the smoke asset makes rotation step 1 and says why.
3. **Over-correction.** The session might now dispatch jobs for casual link-sharing.
   Mitigated by scoping the directive to "a link shared *as the subject of work*";
   watch the first week of live behavior.
