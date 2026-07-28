# Stage 36: Generative UI authoring unblocked: nightshift ui validate/install read HTML from stdin

- **Type:** bug
- **Depends on:** 35
- **Bug evidence:** live DoD run 2026-07-28 ~20:23–20:28 UTC, session
  84b4442c on prod — see feature-assessments/generative-ui-assessment.md
  §Stage-36 addendum. Issue #82 (related worker-profile findings: #81).

## Objectives

The conversational session can actually complete the Stage 35 authoring loop.
Live cert exposed the composition gap: the loop says "write the HTML to a temp
file", but the session's containment (`--allowedTools "Bash(nightshift *) …"`,
src/session/manager.ts:68, ADR 0007 posture) grants NO file-write path — every
Write/heredoc attempt was denied until the 300s turn cap killed the turn
(journal 20:28:42Z "agent turn timed out"). Fix WITHOUT widening the sandbox:
`nightshift ui validate -` and `nightshift ui install -` read the HTML from
STDIN, so one allowlisted `nightshift … <<'EOF'` command carries the page.

## What to build

1. **`bin/nightshift`**: in the `ui` verb family's `readHtml` (bin/nightshift
   ~line 450), accept `-` as the file argument → read stdin to EOF (existing
   file-path behavior unchanged). Applies to `ui validate -` and
   `ui install - --name <n> …`. Reject an empty stdin body with the usage
   error. Update USAGE text to document the `-` form.
2. **`GENERATIVE_UI_PREAMBLE`** (src/session/manager.ts:129, the THE LOOP
   line): replace the write-a-temp-file instruction with the stdin form —
   compose the page and pipe it in ONE command:
   `nightshift ui validate - <<'NSUI_EOF' … NSUI_EOF`, then
   `nightshift ui install - --name <n> [--tools a,b] --provenance "…" <<'NSUI_EOF' … NSUI_EOF`.
   Note the heredoc delimiter must not occur in the page. No other preamble
   lines change.
3. **No door, daemon, or contract changes.** The doors already take `{ html }`
   in the POST body; this is purely a CLI input form + preamble fix. No new
   flag (Stage 31's gates it), no migration.

## Interface contracts

- **Exposes:** the additive `-`/stdin input form on the two CLI verbs
  (contracts/generative-ui.md CLI section is extended additively — the frozen
  door shapes and verb names are untouched).
- **Consumes:** contracts/generative-ui.md (frozen v1) as-is;
  contracts/assistant-session.md untouched (no spawn-shape or allowlist
  change — that is the point of this design).

## Testing requirements

- **Regression test (fails before, passes after):** CLI-level test piping a
  valid page into `ui validate -` (exit 0, verdict valid) and
  `ui install - --name …` (registers v1); invalid page in via stdin → exit 1
  with the verdict; empty stdin → usage error, nothing written. Mirror the
  existing CLI test harness (test/cli.test.ts patterns).
- **Preamble drift test** (test/control.test.ts): update the pinned LOOP
  strings; the verb/flag drift detector must still pass; ADD a pin that the
  preamble no longer instructs writing files ("temp file" absent) and does
  contain the `<<'` heredoc form.
- Existing suite green; conformance harness green in both flag states
  (CI legs unchanged).
- **Live-cert exit (the real proof, on prod after deploy):** in a fresh
  rotated session, the assistant completes install end-to-end from a chat
  request — specifically the allowlist accepts a single
  `nightshift ui install - <<'…'` heredoc command with NO permission denial
  (this is the one claim CI cannot prove: the claude CLI's permission
  matcher on a heredoc-fed allowlisted command). If the matcher denies it,
  STOP and re-intake — fallback design (a dedicated writable drafts dir via
  `--add-dir`) needs an ADR because it widens the sandbox.
- **Smoke asset:** extend docs/smoke/generative-ui.md step 1 with the stdin
  mechanics note + the retry guidance (the DoD phone script itself is
  unchanged from the owner's view).

## Acceptance conditions

- [ ] Reproduction captured + a regression test (fails before, passes after)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
