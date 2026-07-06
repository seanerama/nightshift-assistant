# Stage 2: Rotation ritual: daily summary, memory promotion, seeded fresh sessions

- **Type:** feature
- **Depends on:** 1

## Objectives

Implement `rotate()` from `contracts/assistant-session.md`: the conversational
session gets deliberate lifecycle boundaries. At rotation the outgoing session writes
a day-summary (permanent daily log), durable facts are promoted into memory files,
the transcript location is archived, and the next session boots seeded with memory +
the latest summary — so context stops growing unboundedly while continuity survives.
Triggers: daily at a configured hour, a size-cap safety valve, and manual. This is
the vision doc's "Session & context model" layer 2 made real.

## What to build

1. **`rotate(reason)` in the session manager** (`src/session/`), per the frozen
   contract's ritual, returning `RotationRecord`:
   - Run one final summary turn against the OUTGOING session (via the existing
     `NIGHTSHIFT_AGENT_BIN` seam): a fixed summarization prompt asking for what was
     discussed/decided/built/unfinished, plus a clearly-delimited "DURABLE MEMORY"
     section of facts worth keeping (may be empty).
   - Write the summary to `logs/daily/YYYY-MM-DD.md` (append a numbered suffix if
     rotating twice in one day). Paths relative to the app dir; directory layout is
     OWNED by the session manager per the contract.
   - Promote the durable-memory section into `memory/` files (`memory/MEMORY.md`
     index + dated append is sufficient for this stage; no dedup intelligence yet).
   - Record the outgoing session's transcript path (claude CLI project transcript
     location; resolve from the CLI's project-dir convention, verify it exists,
     store the path — copying is optional) in the rotation record.
   - Mark the sessions row rotated (`is_current=0`, `rotated_at`, `rotation_reason`)
     — reuse the row lifecycle Stage 1 established; rotation history accumulates as
     rows. If the summary turn fails, STILL rotate (log the failure, write a stub
     summary noting it) — a wedged session must never be able to prevent its own
     retirement.
2. **Seeding**: when `relay()` starts a brand-new session (no current row), prepend
   seed context — concatenated `memory/` files + the most recent `logs/daily/`
   summary — via the agent invocation (system-prompt append or first-turn preamble;
   implementer's choice, but it must not pollute the user-visible reply). Size-bound
   the seed (config, default ~16KB) with newest-content-wins truncation.
3. **Triggers**:
   - Daily: a minimal in-daemon interval check (no external scheduler yet — the
     general scheduler is a later stage): rotate when local hour passes
     `NIGHTSHIFT_ROTATE_HOUR` (default 4) and the current session predates today's
     boundary. Missed boundaries (daemon was down) rotate on next check.
   - Size-cap: track a per-session turn counter (additive migration 0002: add
     `turns INTEGER NOT NULL DEFAULT 0` to `sessions`); when a relay pushes it past
     `NIGHTSHIFT_SIZE_CAP_TURNS` (default 200), rotate after that turn completes and
     set `rotated: true` in that turn's AssistantReply.
   - Manual: not operator-exposed yet (no capability wiring stage); expose
     `rotate()` internally so later stages can call it.
   - Serialize rotation with relay turns (same queue) — never rotate mid-turn.
4. **Notification**: after a successful rotation, send a one-line notice through the
   existing `send()` helper ("Rotated the conversational session (daily); summary at
   logs/daily/2026-07-07.md") to the owner's most recent room. If no room is known
   yet, skip silently (log it).
5. **Config**: `NIGHTSHIFT_ROTATE_HOUR`, `NIGHTSHIFT_SIZE_CAP_TURNS`,
   `NIGHTSHIFT_SEED_MAX_BYTES` added to `.env.example` (documented defaults; the
   config contract from Stage 1 — code reads nothing undocumented).

## Interface contracts

- **Exposes:** `rotate(reason)` + `RotationRecord`, the `logs/daily/` + `memory/`
  file layout, and the seeded-session behavior later stages (capability wiring, help
  mode) rely on.
- **Consumes:** `contracts/assistant-session.md` (rotate/RotationRecord are already
  frozen there — implement exactly that shape); `contracts/webex-ingress.md`
  (`send()` for the rotation notice). NO new contract; NO edits to frozen ones.
  Additive migration 0002 only (new column, default backfill).

## Testing requirements

Stub the agent binary at the seam (Stage 1's fixture pattern); never stub the ritual.

- **Ritual happy path:** rotate('daily') → summary turn runs against the outgoing
  session id; `logs/daily/<date>.md` written; durable section lands in `memory/`;
  sessions row flipped (`is_current=0`, reason recorded); RotationRecord fields all
  populated; next relay starts a NEW session whose invocation carries the seed.
- **Summary-turn failure:** agent stub exits nonzero → rotation still completes with
  a stub summary; failure logged.
- **Size-cap:** with cap set low (e.g. 3), the 4th relay triggers rotation; that
  reply has `rotated: true`; turn counter resets on the new session.
- **Daily boundary:** with a fake clock/boundary injection, a session started
  yesterday rotates at the next check; a session started today does not.
- **Seed bounding:** oversized memory/summary content truncates to the byte limit,
  newest content preserved.
- **Serialization:** a rotation queued behind an in-flight relay turn waits for it.
- **UI-smoke asset** (`docs/smoke/stage-2.md`): on the live host, trigger a manual
  rotation (documented one-liner against the daemon), then send a message referencing
  yesterday's topic and confirm the reply shows seeded continuity; verify the daily
  log file exists on the host.

## Acceptance conditions

- [ ] Kill-switch: rotation triggers disabled unless `NIGHTSHIFT_ROTATION_ENABLED=true`
      (default OFF — relay behavior is unchanged until the operator enables it)
- [ ] UI-smoke "observably-works" check authored (`docs/smoke/stage-2.md`)
- [ ] Additive migration only (0002 adds a column with a default; nothing destructive)
- [ ] Existing suite stays green; CI all-green
- [ ] `.env.example` covers every new env read; no secret material in repo
- [ ] Frozen contracts untouched (rotate() implements the existing contract text)

## Pipeline test: NO
