# 0001. Modular monolith: one core daemon, four modules

- **Status:** Accepted
- **Date:** 2026-07-06

## Context

Nightshift Assistant replaces the NSAF core, whose defining structural failure was
fragmentation: a Python Flask app + Webex bot, a Node orchestrator, and an idea-generator
all writing to one SQLite database through hand-copied schemas (six copies), with two
competing promotion paths and no shared state-transition rules. The remediation review
(`docs/assistant-keep-kill.md`, "Structural lessons") traces most of its 37 findings to
this split. The new system's workload is inherently one coordinated concern: receive a
Webex message, relay it to a Claude session, supervise background worker sessions, and
run scheduled rituals — all against one state store, for one user.

## Decision

One deployable daemon — the **Nightshift core** — organized as four internal modules
with explicit seams:

1. **transport** — Webex webhook ingress (HMAC-verified, fail-closed), outbound message
   chunking/sending, attachment handling. Only the webhook path is publicly exposed.
2. **session manager** — the single conversational Claude Code session: resume-per-message,
   daily rotation ritual (summary → daily log, durable facts → memory files, transcript
   archived), size-cap early rotation.
3. **job runner** — background worker sessions (app builds, stories, research): persisted
   job records with PIDs, reconciliation against live processes on startup and each poll,
   guarded state transitions, bounded retries, explicit completion sentinels.
4. **scheduler** — rotation trigger, reminders, watchdog heartbeat.

Claude Code sessions are spawned child processes, not services. The `skills/` pipelines
remain external capabilities invoked by sessions, not part of this codebase.

## Alternatives considered

- **Multi-service (transport service + orchestrator service)** — recreates the old
  split; multiplies CI matrix, images, and deploy surface for zero scaling need
  (single user, single host). Rejected.
- **Serverless/queue-based** — the daemon supervises long-lived local child processes
  and local files; a stateless platform fights that constantly. Rejected.

The stack-and-topology guide recommends starting as a modular monolith; this project is
the guide's happy path, and the predecessor is a case study in why.

## Consequences

- One CI pipeline, one image/artifact, one systemd unit, one schema (ADR 0004).
- Module seams are enforced by frozen contracts (`contracts/`) so later stages and
  agents can extend one module without re-litigating the others.
- If a module ever genuinely needs independent scaling (unlikely at one user), splitting
  it out is a new contract + new service slug (`nightshift-assistant-<service>`), not an
  edit to existing contracts.
