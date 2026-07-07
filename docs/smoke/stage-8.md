# UI smoke — Stage 8 (ack-first: receipt signal for slow turns)

Operator steps to verify the deferred human ack on the live host: force a slow
turn (fresh session boot), see the one-line receipt land within ~6 seconds,
then the real answer after — and confirm fast turns and the 0-disable knob
stay silent. Run after deploy, with the Stage 1 smoke already passing.

## Prerequisites

- Stage 1 smoke passes (health check + round-trip ping).
- The feature is ON by default (`NIGHTSHIFT_ACK_AFTER_SEC=5`). Confirm the env
  file the service loads either omits the var or sets a positive value, then
  restart if you changed it.

## 1. Slow turn → receipt, then the real answer

Force a slow turn: rotate so the next message boots a fresh session (fresh
boots are the reliably slow case), then message the bot.

```sh
cd ~/apps/nightshift-assistant && nightshift rotate   # control surface on
# (no control surface? just ask a question that needs tool use, e.g.
#  "read your own README and summarize it")
```

From Webex, send: **"What can you do?"**

**Expect:**

1. Within ~6 seconds: `🌙 On it — working on your request…` — one line, once.
2. Then the real answer arrives as its own later message.
3. Exactly ONE receipt — never two, and never a receipt after the answer.

Daemon log shows `slow turn: sending receipt ack` followed by
`reply delivered` for the same messageId.

## 2. Fast turn → no receipt

Send a trivial follow-up in the same conversation (warm session): **"ping"**.

**Expect:** the answer alone, no `🌙 On it` line before it. If a warm turn
still takes >5s on your host, that receipt is correct behavior — retry with
an even simpler message before treating it as a failure.

## 3. Kill-switch equivalent (0 disables)

```sh
# in the env file the service loads
NIGHTSHIFT_ACK_AFTER_SEC=0
systemctl --user restart nightshift-assistant
nightshift rotate   # force another slow first turn
```

From Webex, send another message.

**Expect:** silence until the real answer — no receipt no matter how slow the
turn. Restore the default (delete the line or set `5`) and restart when done.

## Failure triage

- No receipt on a genuinely slow turn → check the loaded env for
  `NIGHTSHIFT_ACK_AFTER_SEC=0`, and the journal for
  `ack send failed (real reply unaffected)` (Webex send error — the real
  reply still arrives; the ack itself failed).
- Receipt but no real answer → the ack worked; the turn itself failed. Look
  for `webhook processing failed after ack` / turn-timeout lines in the
  journal — that is a Stage 1 relay problem, not an ack problem.
- Two receipts for one message → file a bug; the transport must arm at most
  one timer per inbound messageId.
- Daemon won't start after editing the env → the var must be a non-negative
  integer; `journalctl --user -u nightshift-assistant` shows the ConfigError.
