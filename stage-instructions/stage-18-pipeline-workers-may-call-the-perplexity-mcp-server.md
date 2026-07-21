# Stage 18: Pipeline workers may call the Perplexity MCP server

- **Type:** feature
- **Depends on:** 6

## Objectives

Restore Perplexity-quality research in headless pipeline jobs. Observed since the
first guide smoke (v0.7.0, job 0025de85) and re-reported by the owner 2026-07-21:
the sws/tg research stages call "Perplexity MCP", but the pipeline permission
profile has no MCP allow-rule, so headless workers get the tool denied and the
skills silently fall back to WebSearch. One allow-rule fixes every pipeline type
at once (story/study/brief/guide share the profile).

## What to build

Add `mcp__perplexity` to `PIPELINE_ALLOWED_TOOLS` in `src/jobs/types.ts` — the
SERVER-level rule (all tools of that one server), consistent with how the host
configures it: user-scope `settings.json` `mcpServers.perplexity`
(`npx @perplexity-ai/mcp-server`, API key embedded in the server's own env
config, so the CLI launches it credentialed; workers need no new extraEnv —
the existing `PERPLEXITY_API_KEY` entries stay for the curl path).

Deliberately NOT: a bare `mcp__*` (would grant every configured MCP server),
any per-tool enumeration (the server's tool names are its own contract), or
touching the generic/app-build profiles.

Comment discipline: extend the PIPELINE_ALLOWED_TOOLS header comment with the
rule's rationale (research seam; server-level; key lives in the host MCP config).

## Interface contracts

- **Exposes:** nothing new on the wire — worker spawn argv only.
- **Consumes:** `contracts/job-lifecycle.md` untouched (permission profiles are
  registry-internal). Host seam: `mcpServers.perplexity` in the host user
  settings — same host-resolved dependency class as the skills themselves
  (Stage 6 precedent).

## Testing requirements

- Pin `mcp__perplexity` present in the pipeline profile (types.test.ts registry
  pins) and absent from the generic spawn (jobs.test.ts raw-shape pin already
  proves generic has NO permission args — extend the guide/typed spawn test to
  assert the allowedTools value contains `mcp__perplexity` and still no bare
  `Bash`).
- HOST PROBE (pre-merge if reachable, else recorded as a smoke step): headless
  `claude -p` on the prod host with `--allowedTools "mcp__perplexity"` asking for
  one trivial Perplexity search — expect a tool RESULT, no permission_denials
  (the Stage 6 probe discipline; the CLI's MCP rule syntax must be verified
  against the installed CLI, not assumed).

## Acceptance conditions

- [ ] Kill-switch: existing `NIGHTSHIFT_TYPES_ENABLED` gate (profile only applies
      to typed spawns; raw/generic unaffected) — no new flag, record rationale.
- [ ] UI-smoke authored (`docs/smoke/stage-18.md`): host probe above + one real
      research-stage check (a fresh small guide/study job whose
      `research/*.md` cites Perplexity results rather than the WebSearch
      fallback wording).
- [ ] Additive migration only — no schema change (one string in one const).
- [ ] Existing suite stays green; CI all-green.

## Security note

Server-level allow for ONE research server whose credential is held by the host
MCP config, not the worker env. No write/push capability is granted; the rule
does not widen Bash or file scopes. Never generalize to `mcp__*`.

## Pipeline test: NO
