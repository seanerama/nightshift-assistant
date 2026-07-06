# Contract: assistant-session

- **Status:** frozen v1
- **Owner:** session-manager module

## Exposes

- **relay(msg: InboundMessage) → AssistantReply** — the single entry point the
  transport calls. Ensures the current conversational session exists (create or
  resume), appends the user turn, returns the assistant's reply:
  ```
  {
    schema: 1,
    text: string,             // markdown reply (transport chunks it)
    files: string[],          // paths of produced files to attach (may be empty)
    sessionId: string,        // Claude Code session id that produced the reply
    rotated: boolean          // true if this turn triggered a size-cap rotation
  }
  ```
- **rotate(reason: 'daily' | 'size-cap' | 'manual') → RotationRecord** — invoked by the
  scheduler (daily), by relay (size-cap), or by operator request. Performs the ritual:
  1. outgoing session writes the day-summary;
  2. summary saved to `logs/daily/YYYY-MM-DD.md`;
  3. durable facts promoted into the memory directory;
  4. full transcript location archived/recorded;
  5. next session seeded with memory files + latest summary.
  ```
  RotationRecord: {
    schema: 1,
    closedSessionId: string, newSessionId: string,
    reason: 'daily'|'size-cap'|'manual',
    summaryPath: string, transcriptPath: string, rotatedAt: string  // ISO 8601
  }
  ```

## Consumes

- **webex-ingress**: InboundMessage shape; `send()` for proactive/mid-work notices.
- The `claude` CLI (headless, resumable sessions, JSON output mode).
- Filesystem layout it OWNS (single source of truth for these paths):
  - `logs/daily/YYYY-MM-DD.md` — rotation summaries (permanent record)
  - `memory/` — durable memory files loaded into every new session
  - `logs/transcripts/` — archived transcript locations/copies
- SQLite (ADR 0004): `sessions` table — current session id, started/rotated
  timestamps, rotation history.

## Schema / wire

- Exactly ONE conversational session exists at a time (single user). relay() calls
  serialize on it; a second inbound message queues behind the first.
- **Long-running work never runs in the conversational session** — the session
  dispatches jobs via the job-lifecycle contract and replies immediately; job
  completion notices arrive via `send()`.
- Session boundaries: daily rotation at the configured hour (default 04:00 local)
  plus a size-cap early rotation; both use the identical ritual above.
- If the session process dies mid-turn, relay() returns an error reply (never
  silence) and the next message starts/resumes cleanly.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
