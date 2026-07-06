# Stage 3: Pending-session detection must be explicit, not turns==0

- **Type:** bug
- **Depends on:** 2

## Objectives

Fix the live-found Stage 2 defect: `relay()` decides "this is a rotation-created
pending session, start it with `--session-id` + seed" by testing `turns === 0`.
That heuristic is ambiguous — migration 0002 backfilled `turns = 0` onto the
pre-existing live session, so the daemon tried to START an already-materialized
claude session and the CLI refused (`Session ID … is already in use`, exit 1),
burning the operator's turn and force-retiring the session as 'died' with no
summary. Pending-ness must be an explicit persisted marker.

**Live reproduction (2026-07-06, v0.1.0 first enabled run):** journal shows
`agent turn failed … stderr: "Error: Session ID f0138138-… is already in use."`
immediately after enabling rotation on a database whose current session predated
migration 0002.

## What to build

1. **Migration 0003 (additive):** `ALTER TABLE sessions ADD COLUMN pending
   INTEGER NOT NULL DEFAULT 0;` + schema_version row, per the ladder pattern.
   Backfill default 0 is exactly right: pre-existing rows are NOT pending.
2. **Rotation marks pending explicitly:** the fresh row `rotateNow()` inserts
   gets `pending = 1` (still `turns = 0`).
3. **`relay()` new-session detection:** use `current === null || current.pending === 1`
   (dropping the `turns === 0` test). A pending row starts under its pre-assigned
   id (`--session-id`) with the seed; any non-pending row — whatever its turn
   count — is resumed with `--resume`.
4. **Clear the marker on materialization:** after the first successful turn on a
   pending row, set `pending = 0` (alongside the existing session-id persistence).
5. **`maybeRotateDaily()` skip:** skip when `current.pending === 1` (unused
   rotation-created session) — this replaces the `turns === 0` skip so a
   backfilled-but-real session (turns lies at 0) still rotates on the daily
   boundary once eligible.

No behavior change for genuinely fresh databases or for rotation-created rows;
seeding, size-cap, and the ritual are untouched.

## Interface contracts

- **Exposes:** nothing new.
- **Consumes:** `contracts/assistant-session.md` semantics unchanged (this is an
  internal state-tracking fix; the contract never specified the detection
  mechanism). NO contract edits; additive migration only.

## Testing requirements

- **Regression (fails on Stage 2 code, passes after):** build a DB simulating the
  live incident — apply migrations, insert a current row with a session id,
  `turns = 0`, `pending = 0` (the migration-backfill state) — then relay: the
  agent stub argv MUST contain `--resume <id>` and MUST NOT contain
  `--session-id`.
- Rotation still creates a pending row; the next relay starts it with
  `--session-id` + seed and clears `pending` after success.
- A pending row whose first turn FAILS keeps `pending = 1` (retry next message
  still starts, not resumes).
- `maybeRotateDaily()` skips a pending current row; a non-pending `turns = 0`
  row past the boundary DOES rotate.
- Migration 0003 applies idempotently on both a fresh DB and a v2-head DB.

## Acceptance conditions

- [ ] Reproduction captured + a regression test (fails before, passes after)
- [ ] Existing suite stays green; CI all-green
- [ ] Additive migration only (0003 adds a defaulted column)
- [ ] Frozen contracts untouched

## Pipeline test: NO
