# 0010. Single-counter SQLite outbox for app-transport delivery

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

The app contract requires ack-fast/work-off-path: `POST /app/v1/messages`
returns 202 before `relay()` runs, and the reply arrives later as an event. A
mobile client is intermittently connected — it must be able to drop off SSE and
recover every event it missed, whether it resumes via `Last-Event-ID` on
`GET /events` or polls `GET /outbox?after=`. "State can't lie" (ADR 0004) means
delivery state must live in SQLite, not in process memory.

## Decision

- New table `app_outbox` (migration): monotonic **INTEGER PRIMARY KEY** `id`,
  `type` (`ack` | `reply` | `notice`), `payload` (JSON), `created_at`,
  `delivered_at` nullable.
- **One counter, no exceptions:** `id` is simultaneously the SSE
  `Last-Event-ID` and the `?after=` cursor. The harness's `cursor.equivalence`
  check certifies this; a second sequence or per-channel numbering is forbidden.
- **Durable before live:** the outbox row is committed before any live SSE
  emit. A crash between commit and emit loses nothing — the client re-reads
  from its cursor.
- The `send()` fan-out registers the app sink **beside** the Webex sink; the
  Webex path is byte-identical to before. Proactive sends become `notice`
  events; replies become `reply` carrying the AssistantReply shape; session
  acceptance emits `ack`.
- Inbound dedup on the client-supplied UUID: a re-POST returns 202 and emits
  nothing new.
- **No pruning** in v1 — retention is unspecified in contract v1.0.0. A
  `TODO(contract-v1.0.1)` marker sits where pruning would go.

## Alternatives considered

- **In-memory ring buffer + SSE only** — rejected: a daemon restart would
  silently lose undelivered replies; state would lie.
- **Per-connection queues / per-type sequences** — rejected: the contract makes
  the cursor and the SSE event id the same number; anything else fails
  `cursor.equivalence` and complicates resume.
- **Prune on `delivered_at`** — rejected for now: retention semantics are the
  contract's to define; guessing here means a client that polls late reads a
  hole. Revisit at contract v1.0.1.

## Consequences

- `app_outbox` grows unboundedly until the contract specifies retention —
  acceptable at single-owner message volume; the TODO marks the debt.
- `delivered_at` is bookkeeping, not a delivery guarantee — the cursor is the
  truth a client trusts.
- The migration applies with the flag off (routes absent, table dormant), so
  deploy-dark stays safe.
