# Stage 9: Workers must survive daemon restarts: KillMode=process

- **Type:** bug
- **Depends on:** 4

## Objectives

Fix the live-found Stage 4 invariant violation: detached workers are killed by
`systemctl restart` anyway, because systemd's default `KillMode=control-group`
kills every process in the unit's cgroup — detachment protects against parent
death, not cgroup teardown. The v0.4.0 deploy (2026-07-07 ~04:0x UTC) killed the
running study worker (e943c00d, pid 3745695: no sentinel, empty log, died at
restart). The recovery machinery then worked exactly as designed (reconciler →
failure path → bounded retry b4457b89 → StudyWS resume), but every deploy
currently costs each in-flight worker an attempt — with a cap of 2, two deploys
during one job = spurious terminal failure.

## What to build

1. `systemd/nightshift-assistant.service`: add `KillMode=process` (+ a comment
   citing this incident) so stop/restart signals ONLY the main daemon process;
   detached workers keep running and the startup reconciler re-adopts them via
   persisted PIDs (the already-tested Stage 4 path).
2. Verify deploy.sh's unit regeneration carries the new line through its sed
   pipeline untouched (it should — it only rewrites User=/WantedBy=/paths; add
   the assertion to the smoke, not code).
3. docs/smoke/stage-9.md: on-host check — submit a sleeper-ish job (or during
   any real job), `systemctl --user restart nightshift-assistant`, confirm the
   worker PID survives, the row stays `running`, no attempt is consumed, and
   the job later settles normally.

## Interface contracts

No code, contracts, config, or migration changes — ops artifact only.

## Testing requirements

Not unit-testable (systemd behavior); the UI-smoke IS the regression check.
Existing suite must stay green (no source changes expected).

## Acceptance conditions

- [ ] Reproduction captured (this spec) + smoke asserts the invariant on the live host
- [ ] Existing suite stays green; CI all-green
- [ ] Frozen contracts untouched; no migration

## Pipeline test: NO
