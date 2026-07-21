# UI smoke — Stage 18 (Perplexity MCP for pipeline workers)

Verifies headless workers can actually CALL the Perplexity MCP server — the rule
syntax against the installed CLI, the host's server config, and the end-to-end
research quality. Run on the prod host after deploy.

## Steps

1. Host prerequisites:

   ```sh
   grep -A3 '"perplexity"' ~/.claude/settings.json   # mcpServers.perplexity present (npx @perplexity-ai/mcp-server)
   ```

2. Headless probe (the Stage 6 probe discipline — proves the rule syntax against
   the INSTALLED CLI, cheap and immediate):

   ```sh
   cd $(mktemp -d) && claude -p 'Use the perplexity MCP tool to search for "git bisect" and reply with the first result title only.' \
     --model claude-sonnet-5 --output-format json --allowedTools "mcp__perplexity" | python3 -c 'import json,sys; r=json.load(sys.stdin); print("denials:", r.get("permission_denials", "n/a")); print(r.get("result","")[:200])'
   ```

   **Expect:** empty/no permission_denials and a real result title. A denial here
   means the rule spelling is wrong for the installed CLI — stop, fix, redeploy.

3. End-to-end research check — submit a small guide job and inspect its research
   output:

   ```sh
   nightshift submit --type guide --params '{"topic": "jq basics", "variant": "explainer"}'
   # after the ✅ notice:
   grep -il "perplexity" ~/projects/jq-basics/output/*/research/*.md | head -3
   ```

   **Expect:** research files citing Perplexity-sourced results (the skills label
   their source), NOT the WebSearch-fallback wording ("fell back", "WebSearch").

## Failure triage

- Probe denied → rule spelling vs installed CLI (try `mcp__perplexity__*` form and
  re-verify; update the registry const to whatever the probe proves).
- Probe passes but research still falls back → the worker session isn't loading
  the user-scope MCP server (check the job's worker.log for MCP startup errors;
  `npx` needs network on first run) or the skill's fallback triggered on latency.
- `permission_denials` empty but no result → the MCP server itself failed
  (API key in the host's server config expired/missing).
