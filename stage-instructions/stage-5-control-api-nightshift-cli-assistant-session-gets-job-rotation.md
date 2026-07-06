# Stage 5: Control API + nightshift CLI: assistant session gets job/rotation/status tools

- **Type:** feature
- **Depends on:** 4

## Objectives

Implement `contracts/control-api.md` (frozen v1) and give the conversational
session its hands: a loopback-only `/api/v1/` surface over `App.jobs` +
`App.sessions.rotate`, a committed `nightshift` CLI that is both the assistant's
tool and the operator's ops tool, and session spawning that allows exactly
`Bash(nightshift *)`. After this stage, "kill that job" / "what's running?" /
"rotate the session" work from Webex — and the operator runs the same commands
by hand over SSH. (ADR 0007; job-type payloads are Stage 6.)

## What to build

1. **API endpoints** (`src/transport/api.ts`, mounted in the existing server —
   loopback bind is inherited): the exact routes/shapes in
   `contracts/control-api.md`. Thin: validate → call App.jobs / App.sessions →
   map JobError/unknown-id to 4xx, everything else 500. Bearer-token auth on
   every `/api/v1/` request (`NIGHTSHIFT_API_TOKEN`, constant-time compare, 401
   on mismatch, fail closed when unset). Kill-switch `NIGHTSHIFT_CONTROL_ENABLED`
   (default OFF → all `/api/v1/` return 403 with a clear error).
2. **`bin/nightshift` CLI** (committed, executable, zero new deps — node script
   using fetch against `http://127.0.0.1:<port>`): subcommands per the contract
   (`submit --type --title --instruction --workdir`, `jobs [--status]`,
   `job <id>`, `kill <id>`, `rotate`, `status`), `--json` passthrough, exit codes
   per contract, readable table/text output otherwise. Reads
   `NIGHTSHIFT_API_TOKEN`/`NIGHTSHIFT_PORT` from env, falling back to the app
   dir's `.env` (workers don't have the token in env — see security note).
3. **Session tool access** (`src/session/manager.ts`): spawn the conversational
   session with `--allowedTools "Bash(nightshift:*)"` (verify the exact matcher
   syntax the installed claude CLI expects for argument-prefixed Bash rules;
   document it in the code). Gate this on `NIGHTSHIFT_CONTROL_ENABLED` so the
   flag-off session spawn stays byte-identical to Stage 4 behavior.
4. **Session awareness**: extend the seed/system-prompt (Stage 2's
   `--append-system-prompt` path) with a short fixed capability preamble telling
   the session it has the `nightshift` CLI, when to use it (dispatch long work,
   never run it inline), and that job completion notices arrive in Webex on
   their own. Gate on the same flag.
5. **Config**: `NIGHTSHIFT_CONTROL_ENABLED`, `NIGHTSHIFT_API_TOKEN` in
   `.env.example` (validated fail-fast when control is enabled). PATH note: the
   deploy script symlinks `bin/nightshift` into `~/.local/bin` (or the unit's
   PATH) so the session's Bash finds it.
6. **Security invariant** (extends the FIX-H3 posture): `NIGHTSHIFT_API_TOKEN`
   is NOT in `workerEnv()`'s allow-list — workers cannot drive the daemon. The
   CONVERSATIONAL session's spawn env must include it (it needs the CLI) — add
   it explicitly at that one spawn site, not via the worker helper.

## Interface contracts

- **Exposes:** the control surface Stage 6 extends (`POST /api/v1/jobs` gains
  the `type+params` body additively) and the operator's ops CLI.
- **Consumes:** `contracts/control-api.md` (implement exactly),
  `contracts/job-lifecycle.md` + `contracts/assistant-session.md` (unchanged
  shapes over the wire). NO edits to frozen contracts; no migration expected.

## Testing requirements

- **API:** every endpoint happy-path + auth (no token → 401; wrong token → 401;
  constant-time compare), kill-switch (flag off → 403), unknown job → 404,
  invalid submit → 400 with the JobError message. Reuse the runner's worker-stub
  fixtures; no live claude needed.
- **CLI:** run `bin/nightshift` as a child process against a test app instance:
  submit → jobs → job → kill round-trip; `--json` emits raw API JSON; exit code
  1 on error paths; helpful usage on bad args.
- **Session spawn:** with control enabled, argv contains the `--allowedTools`
  rule and the env carries the token; with it disabled, argv/env byte-identical
  to Stage 4 (extend the existing argv-equality test).
- **Security:** extend the env-dump worker test — `NIGHTSHIFT_API_TOKEN` absent
  from worker env.
- **UI-smoke** (`docs/smoke/stage-5.md`): from Webex ask "what's the system
  status?" (expect a reply quoting real `nightshift status` output), then
  "submit a job that writes hello into a file in /tmp/nightshift-smoke and tell
  me its id", watch the finish notice arrive, then `nightshift jobs` by hand
  over SSH and confirm the same truth.

## Acceptance conditions

- [ ] Kill-switch: entire control surface dark unless `NIGHTSHIFT_CONTROL_ENABLED=true`
- [ ] UI-smoke "observably-works" check authored (`docs/smoke/stage-5.md`)
- [ ] Additive migration only (none expected)
- [ ] Existing suite stays green; CI all-green
- [ ] `.env.example` covers every new env read; no secret material in repo
- [ ] Frozen contracts untouched; API token absent from worker env (tested)

## Pipeline test: NO
