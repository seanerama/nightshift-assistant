# 0016. UI-state store: per-resource JSON document behind owner-granted MCP tools

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Live DoD certification (2026-07-28) exposed the gap the brief left open: a
generated page's interactive state (habits the owner adds, checkmarks) lives
only in the WebView's in-memory JS — the ui-bridge contract rightly bans
storage/network, the page's only outbound channel is `tools/call` on its
granted allowlist, and none of the five existing MCP tools stores anything.
The owner's habit-tracker data vanished on iteration to v2 (and would have on
any app restart), and the assistant can never see UI interactions. Pages are
interactive but stateless — demos, not tools.

## Decision

- **A per-resource state document.** New table `ui_state(name TEXT PRIMARY
  KEY, value TEXT /*JSON*/, updated_at)` — state attaches to the resource
  NAME, like grants (ADR 0015), so it survives version iteration and
  rollback by construction. One JSON document per name, 64 KB cap,
  `set` = full replace (last-write-wins). Simple on purpose; a keyed API can
  arrive additively later.
- **Two new MCP tools, `ui_state_get` / `ui_state_set`** (`{ name }` /
  `{ name, value }`), grantable to generated pages through the EXISTING
  zero-trust grant flow (ADR 0015): a page requests them, the owner approves
  in chat, `_meta["ui/tools"]` carries them. Also thin control doors
  (`GET/POST /api/v1/ui/state/<name>`) + `nightshift ui state` so the
  ASSISTANT can read/seed state (e.g. migrate chat-mentioned habits in).
- **Flag-conditional catalog:** the two tools are advertised only when
  `NIGHTSHIFT_GENERATIVE_UI_ENABLED` is on — flag off keeps the certified
  five-tool surface byte-identical (ADR 0011/0012 posture, harness green in
  both states).
- **Scoping caveat, stated honestly:** MCP `tools/call` carries no caller
  identity, so the daemon cannot know WHICH page is calling — a page granted
  `ui_state_set` can name any resource's state. v1 accepts this for the
  single-owner deployment: the grant conversation is the trust decision, and
  the blast radius is the ui_state table only. Recorded as the known
  limitation; per-grant argument constraints (or a shell-attested resource
  identity, a client-repo ui-bridge addition) are the future refinement.

## Alternatives considered

- **Relax the validator to allow localStorage** — rejected: breaks the
  ui-bridge contract (client-owned), state stays invisible to the assistant,
  lost on reinstall, and unsyncable across devices.
- **Bake state into the HTML each version** (assistant rewrites data into
  the page) — rejected as the general mechanism: per-interaction data
  (checkmarks) can't round-trip through chat, and it couples presentation to
  data — the exact bug the owner hit.
- **Keyed KV API per resource** (`get/set(key)`) — deferred: more calls, more
  schema, no v1 need; the single document is additive-compatible with adding
  keys later.
- **Generic daemon KV open to all tools** — rejected: unbounded namespace
  with no ownership story; per-resource-name scoping keeps the registry the
  index (memory-graph hook intact).

## Consequences

- Generated pages become genuinely useful: data survives restarts, versions,
  and rollback; the assistant can read state to answer questions about it.
- The tool catalog is no longer a constant five — tests pinning "exactly
  five" update deliberately; the conformance harness must stay green in both
  flag states (flag off unchanged is the invariant).
- The cross-resource caveat is real surface: every state-tool grant is a
  whole-namespace trust decision until argument constraints exist. The grant
  prompt wording must say so.
- One more migration (0010), additive.
