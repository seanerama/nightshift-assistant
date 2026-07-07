# Stage 8: Ack-first: immediate receipt signal for slow turns

- **Type:** feature
- **Depends on:** 5

## Objectives

Operator-requested (2026-07-06, v0.3.1 smoke): turns can take 30+ seconds (fresh
session boot, tool use) with total silence in between — indistinguishable from a
dead bot. Send a lightweight receipt signal when a reply is not going to be fast,
so the operator always knows the message landed. (Old-NSAF lesson ENH-07:
ack-first; the transport already acks Webex's webhook — this is the HUMAN ack.)

## What to build

1. **Deferred ack in the transport** (`src/transport/server.ts` or a small
   helper): when relay() has not produced a reply within
   `NIGHTSHIFT_ACK_AFTER_SEC` (default 5), send ONE short receipt via the
   existing `send()` (e.g. "🌙 On it — working on your request…"), then the real
   reply follows as normal. Timer cancelled when the reply beats it. Never more
   than one ack per inbound message; ack failures are logged, never fatal, and
   never suppress the real reply.
2. **No ack for fast turns** (under the threshold) and none for the bot's own
   proactive notices (job finishes, rotation notes).
3. **Config**: `NIGHTSHIFT_ACK_AFTER_SEC` in `.env.example` (0 disables; default
   5). No kill-switch beyond that knob (the feature is inert when disabled).

## Interface contracts

- **Exposes:** nothing new. **Consumes:** `contracts/webex-ingress.md` `send()`
  (unchanged). No contract edits; no migration.

## Testing requirements

- Slow relay (stubbed delay > threshold): exactly one ack sent before the reply;
  both arrive; ack text distinct from the reply.
- Fast relay: no ack. Threshold 0: no ack ever.
- Ack send failure: logged; the real reply still delivered.
- Duplicate messageId (dedup): no ack (nothing processed).
- **UI-smoke** (`docs/smoke/stage-8.md`): from Webex, first message after a
  rotation (slow turn) → receipt within ~6s, real answer after.

## Acceptance conditions

- [ ] Kill-switch equivalent: NIGHTSHIFT_ACK_AFTER_SEC=0 disables entirely; default documented
- [ ] UI-smoke authored (docs/smoke/stage-8.md)
- [ ] Additive migration only (none expected)
- [ ] Existing suite stays green; CI all-green
- [ ] Frozen contracts untouched

## Pipeline test: NO
