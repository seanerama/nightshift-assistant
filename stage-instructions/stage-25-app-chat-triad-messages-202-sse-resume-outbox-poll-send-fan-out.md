# Stage 25: App chat triad: messages 202, SSE resume, outbox poll, send fan-out

- **Type:** feature
- **Depends on:** 24

## Objectives

Chat works end-to-end through the app door: a posted InboundMessage is acked
fast, relayed off-path, and its reply (plus every proactive notice) is durably
recoverable by cursor — whether the client is live on SSE or polling after a
gap. This stage also introduces the ONE structural change outside
`src/transport/app/`: the send fan-out.

## What to build

1. **`POST /app/v1/messages`:** validate against the pinned `schemas/v1/`
   InboundMessage schema; `personId` != configured owner → 403 (vestigial but
   validated — do not remove); **return 202 BEFORE `relay()` runs** — enqueue
   and go, never hold the request open for a Claude turn (same discipline as
   the webhook handler). Dedup on the client-supplied UUID, durable (a table or
   unique index, not a process-memory set — a daemon restart must not turn a
   retry into a duplicate turn): re-POST → 202, **nothing new emitted**.
2. **Outbox writer:** append-only writes to `app_outbox` (Stage 24's table).
   Event types: `ack` (session acceptance of the inbound), `reply` (the
   AssistantReply shape from `relay()`), `notice` (proactive traffic). **Row
   committed BEFORE any live emit** (ADR 0010) — a crash between commit and
   emit loses nothing; the client re-reads from its cursor.
3. **`GET /app/v1/events`:** SSE. `id:` is `app_outbox.id`; honor
   `Last-Event-ID` on reconnect by replaying rows `> id` from SQLite before
   going live; comment keep-alives on an interval so idle proxies don't drop
   the stream.
4. **`GET /app/v1/outbox?after=<id>`:** poll fallback reading the same table
   with the same cursor. The harness's `cursor.equivalence` check certifies SSE
   ids and `after` cursors are the SAME counter — no second sequence, ever.
5. **Send fan-out (the seam change):** today `sender` is the single Webex
   `Sender` (`src/app.ts:84`) called directly at app.ts:119, 142, 151, 168 — no
   sink registry exists. Introduce a fan-out implementing the same `Sender`
   interface (`src/transport/send.ts:28`) that (a) always calls the Webex
   sender exactly as before and (b) when the flag is on, also writes a `notice`
   outbox row. Hand the fan-out to the existing call sites; the Webex leg is
   byte-identical (chunking, fallback text, attachment semantics all live
   inside the wrapped Webex sender — nothing re-implemented). Flag off →
   fan-out IS the Webex sender (passthrough).
6. **Manifest:** add `"chat"` to capabilities — in the same change that turns
   the chat checks green, never before (declaring is binding, ADR 0009).

**Deliberately NOT in this stage:** uploads/file serving (if the InboundMessage
schema accepts attachment references now, they resolve against the existing
`uploads/<ts>-<name>` layout — `src/types.ts:16` — but no upload route exists
until Stage 26), MCP, UI resources, edits to `src/transport/send.ts` internals,
the session manager, the job runner. `relay()` is consumed exactly as Webex
consumes it.

## Interface contracts

- **Exposes:** the chat triad routes; the fan-out `Sender` (drop-in for the
  existing interface); the outbox event stream the Nightshift Client consumes.
- **Consumes:** `contracts/app-ingress.md` v1 + pinned schemas (normative);
  `contracts/assistant-session.md` v1 — `relay(InboundMessage) →
  AssistantReply` (`src/session/manager.ts:161`), consumed as-is;
  `contracts/webex-ingress.md` v1 — its send() semantics MUST hold unchanged
  through the fan-out.

## Testing requirements

- Unit: durable-before-emit (fail the live emit in a test double — the row
  survives and resume delivers it); dedup across a simulated restart;
  202-before-relay (a relay stub that never resolves — the POST still
  returns); SSE resume from a mid-stream `Last-Event-ID` replays exactly the
  missed rows; personId mismatch → 403.
- Fan-out: flag off → wrapped Webex sender receives byte-identical calls
  (golden assertion on dest/markdown/files); flag on → one `notice` row per
  proactive send AND the Webex call unchanged.
- Existing Webex transport suite stays green untouched.
- CI conformance job (Stage 24) now passes the chat triad including
  `cursor.equivalence` and dedup checks.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) still gates everything
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (n/a until Stage 29 — harness + ordering tests stand in)
- [ ] Additive migration only (no destructive schema change)
- [ ] `"chat"` declared in the same change that turns its checks green
- [ ] Webex byte-identical: `src/transport/send.ts` undiffed; no behavior
      change at the four call sites with the flag off
- [ ] Existing suite stays green; CI all-green including conformance

## Pipeline test: NO
