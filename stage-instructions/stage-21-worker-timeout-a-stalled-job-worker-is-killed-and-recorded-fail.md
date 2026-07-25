# Stage 21: Worker timeout: a stalled job worker is killed and recorded failed, not hung forever

- **Type:** feature
- **Depends on:** none

## Objectives

Close a real robustness gap: today a job worker whose `claude` model call **stalls** hangs
**forever** (observed live 2026-07-25 — a note-ingest worker blocked in `ep_poll` on a stalled
API turn, ~1s CPU over minutes; the runner has no timeout). Add a **per-job wall-clock
timeout**: when a `running` job exceeds it, the worker is killed and the job is recorded
**terminally with a clear "timed out" reason** and the usual failure notice fires. Turns "hung
forever, silent" into "fails cleanly and tells you." Hardens **every** job type.

## What to build

- **Per-job timeout** with a sensible **default** and an optional **per-type override**:
  - Add an optional `timeoutMs?: number` to the `JobType` registry shape (`src/jobs/types.ts`);
    types that omit it inherit the default. Set a tighter value on `note-ingest` (e.g. 15 min).
  - Default via config (`src/config.ts` + `.env.example`): `NIGHTSHIFT_JOB_TIMEOUT_MS`
    (default **generous** — pick a value safely above the longest legit job you can observe in
    the job history so existing study/pipeline jobs are NOT broken; e.g. 30 min). Document it.
- **Enforcement — restart-safe, via the existing reconcile path** (`reconcile()` runs at
  startup + every 60s and already settles dead `running` rows). On each tick, for every
  `running` row, compute age from its **persisted start time** (the `JobRecord`'s
  started/running timestamp — use what already exists; NO schema change) and if
  `age > timeout(row)`, kill the worker (reuse the existing `kill`/SIGTERM→SIGKILL path) and
  transition it terminally with reason "timed out after Nm". Restart-safe because it keys off
  persisted start time, not an in-memory timer. (A per-worker `setTimeout` MAY be added for
  promptness, but the reconcile check is the source of truth and must stand alone.)
- **Terminal outcome**: record as `failed` (it did not succeed) with a timeout reason, OR the
  existing `killed` state if that is the more house-consistent mapping — pick whichever fits the
  frozen state machine and fire the correct notice (`failureNotice`/`killedNotice`) EXACTLY ONCE.
  Make the reason/notice say it timed out (with the elapsed minutes), distinct from an operator kill.

## Interface contracts

- **Consumes (frozen — must not break):** `job-lifecycle` v1 — the guarded state machine
  (terminal states are FINAL; the finish notice fires exactly once). The timeout is a NEW
  *trigger* for an EXISTING transition, not a new state or a state-machine change → **additive**.
  Critically, handle the **race**: a worker that writes its sentinel / exits at the same tick the
  timeout fires must resolve to a single terminal transition (first wins) — no double-transition,
  no double-notice. Reuse the runner's existing guarded-transition + PID-reconciliation logic.
- **Exposes:** the timeout behavior + the `timeoutMs` registry field. No new contract; no schema change.

## Testing requirements

- Unit (vitest, no real worker): a `running` row whose start time is older than its timeout →
  reconcile kills it and transitions it to the terminal timeout outcome with the reason set, and
  fires the notice ONCE; a `running` row within its timeout is untouched; a per-type `timeoutMs`
  overrides the default; the default comes from config.
- Race test: a row that reaches a terminal state (sentinel success) is NOT re-transitioned by a
  concurrent timeout tick (terminal-final; notice fires once).
- Config test: `NIGHTSHIFT_JOB_TIMEOUT_MS` parsed + defaulted; invalid → fail-closed like peers.
- Existing suite stays green.

## Acceptance conditions

- [ ] A stalled/over-age `running` worker is killed + recorded terminally with a "timed out (Nm)" reason; notice fires once.
- [ ] Default timeout is generous enough not to break existing legit jobs; per-type override works; `note-ingest` gets a tighter bound.
- [ ] Restart-safe (keyed off persisted start time via reconcile, not only an in-memory timer).
- [ ] Race with normal completion resolves to a single terminal transition (no double-notice) — job-lifecycle invariants intact; no schema change.
- [ ] Additive only; existing suite green; CI all-green.

## Pipeline test: NO
