# Stage 7: Session PATH must include the nightshift CLI dir

- **Type:** bug
- **Depends on:** 6

## Objectives

Fix the live-found Stage 5/6 defect: the conversational session cannot invoke its
own tool. The daemon runs under the systemd user manager whose PATH lacks
`~/.local/bin` (the deploy symlink location), the session inherits that PATH, so
bare `nightshift` is not found; the model fell back to `./bin/nightshift`, which
the (correctly) tight `Bash(nightshift *)` rule rejected. Result: the capability
shipped in v0.3.0 is unusable from Webex, though the permission gate itself
behaved exactly as designed.

**Live reproduction (2026-07-06, v0.3.0 first control-enabled run):** operator
asked "What's the system status?"; the session reported both `./bin/nightshift`
and `systemctl` denied by the permission gate and answered from `ps` observation
only.

## What to build

1. **Resolve the CLI location at the conversational spawn site** (`src/session/
   manager.ts`): when control is enabled, prepend the app's committed CLI dir
   (`<appDir>/bin`) to the child's `PATH` (preserving the rest of the inherited
   PATH). No reliance on deploy symlinks or unit PATH — works identically in
   dev, tests, and under systemd. Gate on the control flag; flag-off spawn env
   stays byte-identical (extend the existing pinned test).
2. **Capability preamble nudge**: one added line — the tool is invoked as bare
   `nightshift …` (never a path prefix; path-prefixed invocations are denied by
   the permission rule).
3. Leave the `~/.local/bin` deploy symlink as-is (operator convenience); it is
   no longer load-bearing for the session.

## Interface contracts

- **Exposes/Consumes:** no changes to any frozen contract (`control-api`'s CLI
  invocation form `nightshift …` is what this fix makes actually resolvable).
  No migration.

## Testing requirements

- **Regression (fails before, passes after):** with control enabled, the spawned
  conversational session's env PATH begins with `<appDir>/bin` (assert via the
  agent stub's env capture) — and a child process spawned with that PATH
  resolves `nightshift` (execute `nightshift --help` from a stub-shaped PATH in
  the test, proving resolution end-to-end, not just string-prefix).
- Flag-off spawn env remains byte-identical to the Stage 4 baseline (existing
  pinned test must still pass unmodified in its flag-off branch).
- Worker spawns are UNCHANGED (workers do not get the CLI dir; the API token
  absence test still passes).

## Acceptance conditions

- [ ] Reproduction captured + a regression test (fails before, passes after)
- [ ] Existing suite stays green; CI all-green
- [ ] Frozen contracts untouched; no migration
- [ ] Flag-off spawn env byte-identical (pinned test unchanged in that branch)

## Pipeline test: NO
