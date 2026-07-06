# 0007. Control surface: loopback API + nightshift CLI; skills as job payloads; MCP deferred

- **Status:** Accepted
- **Date:** 2026-07-06

## Context

The conversational session needs to invoke actions (submit/kill/list jobs, rotate,
status) without running long work in itself. The architecture left the mechanism
open. Options evaluated with the operator (2026-07-06): (A) an MCP server on the
daemon, (B) a `nightshift` CLI over a loopback HTTP API invoked via the session's
Bash tool, (C) skills as the mechanism, (D) parsing replies for action blocks.
Operator context: expects heavy troubleshooting; wants everything to stay on the
plain claude CLI.

## Decision

**B as the spine, C as the payload.**

- A loopback-only `/api/v1/` HTTP surface on the existing daemon server + a
  committed `nightshift` CLI (contract: `control-api`). The conversational session
  gets exactly `Bash(nightshift *)` via `--allowedTools`.
- Content pipelines stay skills (`/story:*`, `/sws:*`, `/brief:*`): a job TYPE maps
  to a skill invocation run by a WORKER session with a per-type permission profile
  (Stage 6's registry). Skills are never run inside the conversational session.
- Per-install bearer token on the API — a sandboxed worker must not be able to
  drive its own daemon (submit jobs, kill siblings) just by reaching loopback.

## Alternatives considered

- **MCP server (A)**: schema-native tool calls, but more protocol surface to debug
  and no operator benefit. DEFERRED, not rejected — it would wrap the same
  `/api/v1/` later without rework if CLI ergonomics disappoint.
- **Skills as mechanism (C alone)**: skills run in-session; long work in the chat
  session violates the assistant-session contract's hard rule. Payload only.
- **Reply parsing (D)**: the old NSAF dispatcher reborn. Rejected.

The operator-CLI dividend decided it: every action the assistant can take is a
command the operator can run by hand over SSH while debugging — one surface,
inspectable, no hidden protocol.

## Consequences

- Tool calls are text-based; the session may occasionally malform a command and
  retry — visible and self-correcting, accepted.
- The CLI becomes the de-facto ops tool (replaces the on-host node one-liners the
  Stage 2/4 smokes needed).
- `NIGHTSHIFT_API_TOKEN` joins the deploy secrets (locations in
  `.verity/deploy-access.md`); workers do NOT get it (default-deny env).
- If MCP is adopted later, it is an additive layer over `/api/v1/` — no contract
  change.
