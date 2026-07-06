# Stage 4: Job runner: minimal-env worker sessions, reconciliation, sentinels, finish notices

- **Type:** feature
- **Depends on:** 2

## Objectives

Implement `contracts/job-lifecycle.md` in full: background worker sessions with
persisted, reconciled state. Long work (app builds, stories, research) runs in
worker claude sessions that can never wedge the system — persisted PIDs reconciled
against live processes, bounded retries, explicit completion sentinels, exactly one
operator notification per terminal transition, and a default-deny environment so
infrastructure credentials never reach a worker (security carryover FIX-H3; this
stage is its first enforcement point). Internal API only — operator/assistant tool
exposure is the capability-wiring stage.

## What to build

1. **Job runner module** (`src/jobs/`), implementing the contract's surface:
   - `submit(job) → JobRecord` — validate the submit shape (schema 1, type/title/
     instruction/workdir; `env` is always `'minimal'` — reject anything else),
     insert the row `queued` (uuid id, attempts 0, `log_path` + `sentinel_path`
     under a per-job dir `jobs/<id>/` in the app dir), then start it if a
     concurrency slot is free.
   - `kill(id)` — SIGTERM the live process (SIGKILL after a grace period),
     transition → `killed` via the guarded helper.
   - `get(id)`, `list(filter?)` — row reads (filter by status at minimum).
   - `onFinish` callback (wired by the app to a Webex notice through `send()`,
     like rotation's): fires EXACTLY ONCE per terminal transition — success
     (sentinel summary) or failure (exit info + last ~10 log lines).
2. **Worker spawn**: `claude` (the existing `agentBin` seam) run in `workdir`,
   `-p` with the job instruction plus a fixed appended epilogue instructing the
   worker to write the completion sentinel JSON (`{schema:1, status, summary,
   outputs?, url?, port?}`) to its `sentinel_path` as its final act. stdout/stderr
   stream to `log_path`. Record `pid` + `session_id` on the row; transition
   `queued → running` at spawn.
   - **Default-deny environment**: construct the child env from an explicit
     allow-list ONLY (`PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TERM`, and the
     agent seam vars the worker needs). Everything else — `WEBEX_*`, and any
     future SMTP/CF/COOLIFY credentials — must be absent. Centralize as
     `workerEnv()` so later stages reuse it for every spawn type.
3. **Exit routine** (single authoritative path, used by both the exit handler and
   the reconciler): read the sentinel — valid `status:'success'` sentinel →
   `succeeded`; anything else (missing, unparsable, `status:'failure'`, nonzero
   exit without sentinel) → failure path. Per the contract: clean exit WITHOUT a
   sentinel = failed; no progress heuristics, no log-grepping.
   - **Failure path with bounded retries**: increment `attempts`; below the cap
     (config, default 2) → re-queue (transition to terminal `failed` is NOT used
     for retries — insert semantics per contract: the row returns to `queued`);
     at the cap → terminal `failed`. NOTE the contract's state machine has no
     `running → queued` edge: re-queueing is `running → failed` REJECTED… — the
     contract text instead defines retries as part of the failure path ("a failed
     launch increments it and re-queues until the cap"). Implement retry as:
     guarded `running → failed` only at the cap; below the cap, a NEW attempt
     reuses the same row via `queued` ONLY IF the guarded helper legalizes it —
     otherwise (cleaner, still contract-true) mark the row `failed` and
     auto-submit a fresh row copying the job with `attempts+1`, linking via a
     `retry_of` column (additive migration 0004). Builder picks whichever keeps
     `transitionJob` untouched; document the choice in the PR.
4. **Reconciler** (contract ENH-01): on daemon startup and on a poll tick (share
   the 60s interval cadence): every `running` row's `pid` checked against a live
   process (`process.kill(pid, 0)`); dead → the exit routine (sentinel decides).
   Concurrency counts LIVE processes via this check, never raw row counts.
   Queued rows start as slots free (config `NIGHTSHIFT_MAX_JOBS`, default 2).
5. **Config** (documented in `.env.example`, validated fail-fast):
   `NIGHTSHIFT_JOBS_ENABLED` (kill-switch, default OFF — submit() rejects and no
   reconciler/poller runs), `NIGHTSHIFT_MAX_JOBS` (default 2),
   `NIGHTSHIFT_JOB_RETRY_CAP` (default 2), `NIGHTSHIFT_JOB_KILL_GRACE_SEC`
   (default 10).
6. **App wiring** (`src/app.ts`): construct the runner, wire `onFinish` → owner
   notice (reuse `lastOwnerRoomId`), expose `App.jobs` for later stages, start
   reconciler at startup + on the interval (only when enabled), clean shutdown
   (interval cleared; running workers are NOT killed on daemon shutdown — the
   reconciler re-adopts them on restart via persisted PIDs).

## Interface contracts

- **Exposes:** `App.jobs` (submit/kill/get/list + onFinish) — the engine the
  capability-wiring stage surfaces as assistant tools; `workerEnv()` as THE
  sanitized-spawn helper for all future session types.
- **Consumes:** `contracts/job-lifecycle.md` (implement exactly; the JobRecord
  column set already exists in migration 0001), `contracts/webex-ingress.md`
  (`send()` for notices), the guarded-transition helper (`src/db/transitions.ts`)
  for EVERY status write. NO contract edits. Additive migration 0004 only if the
  retry-row approach needs `retry_of`.

## Testing requirements

Worker stub = a controllable script (like the agent stub) that can: write a valid
sentinel then exit 0; exit 0 without a sentinel; exit nonzero; write a failure
sentinel; sleep (for kill/reconcile tests). Never stub the runner logic.

- **Happy path:** submit → queued → running (pid recorded) → worker writes
  success sentinel → `succeeded`; onFinish fired exactly once with the summary;
  row timestamps populated.
- **Sentinel authority:** clean exit, NO sentinel → failure path. Failure
  sentinel → failure path. Malformed sentinel JSON → failure path.
- **Bounded retries:** persistent failure retries up to the cap then lands
  terminal `failed`; attempts recorded; exactly one terminal notification (not
  one per retry — retries may log, only the terminal state notifies).
- **Kill:** kill on a sleeping worker → process dead, row `killed`, one notice.
- **Reconciler:** insert a `running` row with a dead pid → startup reconcile runs
  the exit routine (sentinel present → succeeded; absent → failure path). A
  running row with a LIVE pid is left alone. Concurrency: with max 1 and two
  submits, the second stays queued until the first finishes, then auto-starts.
- **Default-deny env (security):** spawned worker env contains the allow-list
  and does NOT contain `WEBEX_BOT_TOKEN`/`WEBEX_WEBHOOK_SECRET`/
  `WEBEX_OWNER_PERSON_ID` (assert via a stub that dumps its env to a file).
- **Kill-switch:** with `NIGHTSHIFT_JOBS_ENABLED` unset, submit rejects, no
  interval/reconciler activity, daemon behavior otherwise unchanged.
- **UI-smoke asset** (`docs/smoke/stage-4.md`): on the live host — enable the
  flag, submit a trivial real job via an on-host one-liner (worker = real claude
  writing a sentinel), watch it run to `succeeded`, receive the Webex finish
  notice, and verify `jobs/<id>/` holds the log + sentinel. Include a
  kill + reconcile-after-daemon-restart check.

## Acceptance conditions

- [ ] Kill-switch: job runner fully dark unless `NIGHTSHIFT_JOBS_ENABLED=true`
- [ ] UI-smoke "observably-works" check authored (`docs/smoke/stage-4.md`)
- [ ] Additive migration only (0004 only if `retry_of` is chosen)
- [ ] Existing suite stays green; CI all-green
- [ ] `.env.example` covers every new env read; no secret material in repo
- [ ] Frozen contracts untouched; every status write goes through transitionJob
- [ ] Security assertion: worker env default-deny test in the suite

## Pipeline test: NO
