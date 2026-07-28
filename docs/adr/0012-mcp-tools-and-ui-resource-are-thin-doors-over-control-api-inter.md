# 0012. MCP tools and UI resource are thin doors over control-API internals

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

The app contract's `mcp-tools` capability gives the client structured control
(status, jobs, session rotation) alongside chat, and `mcp-apps-ui` lets the
agent ship a rendered dashboard. The daemon already has exactly one control
plane: the control API's thin doors over `App.jobs` and `App.sessions.rotate`
(contracts/control-api.md — "no business logic in the transport"). A second
implementation of job control inside the MCP layer would fork the truth.

## Decision

- `POST /app/v1/mcp` uses the **official TypeScript MCP SDK** (streamable
  HTTP), mounted under the same auth and flag as every other app route.
- **Five tools, each a thin door over the same internals the control API
  uses:** `status`, `jobs_list`, `jobs_submit`, `jobs_kill`, `session_rotate`.
  The tool layer validates arguments and translates shapes — it contains no
  business logic and adds no fields to the frozen JobRecord/RotationRecord
  shapes.
- One UI resource, **`ui://nightshift/jobs@v1`**: a single-file HTML jobs
  dashboard (list, status filter, kill, submit) declaring
  `_meta["ui/tools"]: ["jobs_list", "jobs_kill", "jobs_submit"]`.
- The resource obeys `nightshift-client/contracts/ui-bridge.md`: no network, no
  storage, postMessage JSON-RPC only, render degradable. Because that
  convention lives in the **client** repo, the resource file header cites
  ui-bridge.md so the provenance is recorded.
- Manifest capabilities `mcp-tools` and `mcp-apps-ui` are declared only when
  their stage's harness checks are green (declaring is binding, ADR 0009).

## Alternatives considered

- **MCP tools call the control API over loopback HTTP** — rejected: an
  in-process HTTP hop to yourself adds a serialization boundary and a second
  auth check for zero isolation; both transports calling the same `App`
  internals is the honest topology.
- **Hand-rolled MCP framing** — rejected: streamable HTTP has real edge cases;
  the official SDK is the boring choice (stack-and-topology guide).
- **Richer tool set in v1** (logs tail, promotion, uploads listing) — rejected:
  capabilities are binding and every tool is surface to secure; grow additively
  behind the frozen contract when the client needs it.
- **Versionless UI resource uri** — rejected: `@v1` in the uri makes a breaking
  dashboard change a NEW resource, matching the contracts-first rule.

## Consequences

- Behavior parity with `nightshift` CLI comes for free — both are doors to the
  same internals; a divergence is a bug by definition.
- The MCP SDK becomes a runtime dependency (pinned, lockfile committed).
- The UI resource is testable from MCP Inspector over the tailnet — list,
  call, and read checks are part of the stage exits.
- ui-bridge.md is an external dependency of Stage E review: if the client repo
  revises it, the resource follows at its next version bump, never silently.
