# Stage 23: Assistant dead-ends on a URL instead of dispatching it to a worker that can fetch

- **Type:** bug
- **Depends on:** none

## Objectives

**Reproduction (live, 2026-07-25 ~10:41, v0.12.1):** the owner sent the assistant an
x.com link and asked for a deep-dive techguide. The assistant answered:

> I can't fetch that link — WebFetch was denied in this sandboxed session […] Could you
> paste the text of the post/thread […]? Once I know the actual subject matter, I can
> dispatch a guide job.

Every clause of that is individually correct — and the overall behavior is wrong. The
`guide` job type takes `{"topic": "..."}` (a plain string; a URL is a valid one) and
its workers run on `PIPELINE_PERMISSION_ARGS`, which grants `WebFetch`, `WebSearch`,
**and** `mcp__perplexity` (`src/jobs/types.ts:177`). The worker can fetch what the
session can't. The right move was to dispatch immediately with the URL in the params
and quote the job id; "paste the text" is a *fallback* for when the worker's fetch
fails, not the opener. Instead the owner got dead-ended on a capability the system
already has.

**Root cause is a preamble gap, not a permissions bug.** The conversational session's
grant is exactly the nightshift CLI (`NIGHTSHIFT_TOOL_RULE`,
`src/session/manager.ts:69`) — no WebFetch, deliberately. `CONTROL_PREAMBLE` and its
PERMISSION REALITY block (the #43 fix) teach the session that denials are final and
that pipelines must be dispatched, but nowhere say that **a URL is a legitimate job
payload** or that **workers hold research tools this session lacks**. Handed a link,
the session reasons "I need the content → I can't get the content → ask the owner."
Same failure class as #22, #35, #41: the code is right, the session's briefing is
incomplete.

## What to build

**One new mandatory line in `CONTROL_PREAMBLE`** (`src/session/manager.ts`), in the
established style of the DISPATCH HONESTY / PERMISSION REALITY blocks. Exact wording is
the builder's, but it MUST carry all four elements:

1. **You can never fetch URLs here — and that is by design**, not a misconfiguration
   (this session holds the control token; web content must not reach it directly). Do
   not retry, and do not treat a link as a blocker.
2. **Background workers CAN fetch and research**: pipeline job types run with
   `WebFetch`, `WebSearch`, and Perplexity.
3. **Therefore: when the owner shares a link as the subject of work, dispatch the
   typed job with the URL verbatim in its params** (e.g.
   `nightshift submit --type guide --params '{"topic": "<url> — <what the owner
   asked for>"}'`) and reply with the quoted job id. Never open by asking the owner to
   paste the content.
4. **Social-post caveat:** x.com/Twitter and similar often block server-side fetches
   even for workers; the worker's Perplexity research is the likelier path there.
   Dispatch anyway — and if the job's result comes back unable to read the source,
   *that* is the moment to ask the owner for the text, as a stated fallback.

DISPATCH HONESTY is unchanged and still governs: the job id must come from the CLI.

**Deliberately NOT in this stage:**
- **No `WebFetch` for the conversational session.** That session can dispatch jobs and
  deliver files; letting it read arbitrary web pages widens the prompt-injection blast
  radius that `deliver.ts`'s root confinement exists to bound. The asymmetry is the
  security design, and the new line *says so* rather than papering over it.
- No change to worker permission profiles, job types, or `jobTypesPreamble()`.
- No contract edits — the preamble is not contract surface; `assistant-session` v1 and
  `control-api` v1 are untouched. Precedent: Stage 12 and the #43 fix both amended
  `CONTROL_PREAMBLE` without contract motion.

**Deployment reality the builder and operator must both respect:** the preamble rides
`--append-system-prompt`, which is only applied to **NEW** sessions
(`src/session/manager.ts:442` — `current === null || pending`). A resumed session
keeps its old briefing forever. The fix is inert on live until the session rotates —
the smoke MUST `nightshift rotate` (or wait for the 04:00 ritual) before testing, or
it will "verify" the old prompt.

## Interface contracts

- **Exposes:** nothing new on the wire — spawn-time system-prompt text only.
- **Consumes:** `contracts/assistant-session.md` v1 (relay/spawn path, untouched);
  `contracts/job-lifecycle.md` v1 (typed submit, untouched). The registered-type
  advertisement it leans on is `jobTypesPreamble()` (Stage 6), also untouched.

## Testing requirements

- **Regression test (fails before, passes after):** assert `CONTROL_PREAMBLE` carries
  the URL-handling directive — the never-fetch-here statement, the workers-can-fetch
  statement, the dispatch-with-URL-in-params instruction, and the social/Perplexity
  caveat. This is a golden-string test on the constant, the same class as
  `test/control.test.ts`'s existing containment assertions; it pins the briefing, and
  the *behavioral* proof is the live smoke. Be honest about that split in the test
  comment.
- **Existing `test/control.test.ts` stays green untouched** — its assertions reference
  the `CONTROL_PREAMBLE` constant (not copied strings), including the ordering checks
  (CONTROL before PROMOTE, before REMARKABLE, before the rotation seed), so a text
  edit must not break them. If any of them fail, the edit did something structural it
  shouldn't have.
- **Post-deploy smoke asset — `docs/smoke/stage-23.md`:**
  1. Deploy; then `nightshift rotate` and confirm a new session id (the fix does not
     exist on live before this step — say so in the asset).
  2. Send from Webex: an ordinary article URL + "make a deep-dive guide on this" →
     the reply quotes a real job id and does NOT ask for pasted content;
     `nightshift job <id>` shows the URL embedded in the job's params/instruction.
  3. Send an x.com link → still dispatches, and the reply states the social-fetch
     caveat (Perplexity path / may need pasted text if the worker can't read it).
  4. Negative control: an off-topic denial (e.g. ask it to read a local file outside
     the app dir) still gets the #43 finality behavior — the new line must not have
     softened PERMISSION REALITY.

## Acceptance conditions

- [ ] Reproduction captured + a regression test (fails before, passes after)
- [ ] All four required elements present in the new preamble line; DISPATCH HONESTY
      and PERMISSION REALITY unmodified
- [ ] No permission-profile change anywhere (`NIGHTSHIFT_TOOL_RULE` and
      `src/jobs/types.ts` byte-identical)
- [ ] Smoke asset includes the mandatory rotation step before verification
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
