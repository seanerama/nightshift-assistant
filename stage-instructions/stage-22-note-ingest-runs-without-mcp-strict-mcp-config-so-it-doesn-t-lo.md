# Stage 22: note-ingest runs without MCP: strict-mcp-config so it doesn't load Perplexity

- **Type:** chore
- **Depends on:** none

## Objectives

The `note-ingest` worker inherits the host's `~/.claude` MCP config, so `claude` spawns the
**Perplexity MCP** (`headless_mcp_server.py` + `npm exec perplexity-mcp`) on every run — even
though note-ingest's allowlist grants no `mcp__*` tools, so the model can never use it.
Observed live 2026-07-25. It's wasted startup cost and an extra failure/hang vector. Make the
note-ingest worker load **no MCP servers**.

## What to build

- Append **`--strict-mcp-config`** to `NOTE_INGEST_PERMISSION_ARGS` in `src/jobs/types.ts`.
  With no accompanying `--mcp-config`, `claude` ignores ALL other MCP configuration (verified
  against the installed CLI, v2.1.219: *"Only use MCP servers from --mcp-config, ignoring all
  other MCP configurations"*), so zero MCP servers start.
- Scope: **note-ingest only.** Pipeline types (story/study/brief/guide) legitimately use
  Perplexity (`mcp__perplexity` in their allowlist) and MUST keep their profile unchanged.

## Interface contracts

- **Consumes (frozen):** `job-lifecycle` v1 (unchanged — this only alters one type's worker
  spawn flags). No contract touched, no new contract, no schema change. Additive.

## Testing requirements

- Unit (vitest): `note-ingest` `permissionArgs` contains `--strict-mcp-config` and NO
  `--mcp-config`; the exact-array assertion updated. Confirm the pipeline types' permissionArgs
  are unchanged (still allow `mcp__perplexity`).
- UI-smoke (operator): a real note-ingest run spawns NO `perplexity-mcp` / `headless_mcp_server`
  child processes.

## Acceptance conditions

- [ ] note-ingest worker loads no MCP (`--strict-mcp-config`, no `--mcp-config`); Perplexity not spawned.
- [ ] Pipeline types unchanged (still use Perplexity).
- [ ] Additive; no contract/adr/schema change; existing suite green; CI all-green.

## Pipeline test: NO
