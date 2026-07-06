# 0005. Email as watchdog-only fallback alert channel

- **Status:** Accepted
- **Date:** 2026-07-06

## Context

The vision doc kills email as a notification channel: Webex is the single front door
for everything routine and real-time. But the structural lessons require a heartbeat
watchdog whose alerts survive the failure of the primary channel — "waking up to
silence must be impossible" (remediation ENH-04). If Webex, the tunnel, or the daemon
itself is down, a Webex-only alert is a dead letter.

## Decision

Email survives in exactly one role: the **watchdog's last-resort alarm channel**.

- The watchdog (systemd timer, independent of the daemon process) checks: daemon
  liveness, webhook/tunnel reachability, no job record without a live process, backup
  freshness.
- On failure it alerts via Webex first; if the Webex send fails — or the failure *is*
  Webex/tunnel — it emails the operator.
- No other feature may send email. Morning summaries, digests, completions, reminders:
  Webex only, per the keep/kill decisions.

## Alternatives considered

- **Push service (ntfy/Pushover)** — very reliable, but adds a new credential and
  account for a channel that should almost never fire; email infrastructure and
  habits already exist from NSAF.
- **No fallback (Webex only)** — accepts exactly the "wake up to silence" failure mode
  the watchdog exists to eliminate. Rejected.

## Consequences

- SMTP credentials remain in the deployment environment, scoped to the watchdog —
  they are on the default-deny list for all spawned sessions (security carryover
  FIX-H3).
- A watchdog email means something is genuinely wrong; it is never routine noise, so
  it stays trustworthy.
- Alert-channel checks belong in the watchdog's own tests (a forced Webex-send failure
  must produce an email) — flagged for the tester role.
