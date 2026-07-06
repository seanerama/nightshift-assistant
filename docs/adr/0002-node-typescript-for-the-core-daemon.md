# 0002. Node + TypeScript for the core daemon

- **Status:** Accepted
- **Date:** 2026-07-06

## Context

The vision doc set no stack constraint ("whatever is cleanest"). The daemon's real job
profile: spawn and supervise `claude` CLI child processes, stream/parse their JSON
output, run a small HTTP listener for the Webex webhook, call the Webex REST API,
manage SQLite state, and run timers. No web UI, no CPU-bound work. The predecessor
split this work across Python and Node, which forced two DB layers and duplicated
schemas (see ADR 0001).

## Decision

**Node LTS + TypeScript**, one language for the whole core:

- Process supervision and streaming I/O over child processes are Node's native
  strengths (`child_process`, streams, `AbortController`).
- Stays adjacent to the Claude Code ecosystem (the CLI itself, its headless JSON
  output modes).
- **better-sqlite3** for state (synchronous, transactional, no ORM); a minimal HTTP
  server (Fastify or `node:http`) for the webhook — no web framework beyond that.
- The frozen contracts in `contracts/` are mirrored as TypeScript types, so drift
  between modules is a compile error.
- Dependencies pinned and lockfile committed from the first commit (guide:
  reproducible builds).

## Alternatives considered

- **Python (asyncio + FastAPI/Flask)** — viable and familiar from the old Flask side,
  but subprocess supervision + streaming is more ceremony, and it invites porting
  old-core code wholesale — explicitly not wanted in a rebuild.
- **Go** — excellent supervision and single-binary deploys, but a new language for
  this ecosystem and slower iteration for a personal tool.
- **Keep the Python/Node split** — rejected outright; see ADR 0001.

The guide's lean is "boring, well-supported": Node LTS + TypeScript + SQLite qualifies.

## Consequences

- One `package.json`, one test runner, one lint/format config, one CI job.
- The old core's Python code is reference material only; nothing is ported verbatim.
- Native-module dependency (better-sqlite3) means the deploy host needs a working
  build toolchain or prebuilt binaries — acceptable on the dev server (ADR 0003).
