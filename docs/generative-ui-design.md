# Generative UI resources (`generative-ui`) — Architect handoff to /verity:plan

- **Date:** 2026-07-28 · **Role:** Architect
- **Decisions:** ADR 0013 (assistant generates, daemon deterministically
  validates/registers), ADR 0014 (static-analysis validator; client shell
  sandbox is the security boundary), ADR 0015 (SQLite registry, per-name
  grants, rollback by activation, list_changed over an MCP GET stream).
- **Frozen contract:** `contracts/generative-ui.md` — additive `/api/v1/ui/*`
  doors, `nightshift ui *` CLI verbs, registry schema, validator verdict +
  rule ids, MCP registry mapping.
- **Topology:** unchanged — a UI-registry module inside the modular monolith
  (ADR 0001); doors follow control-api discipline (thin transport, logic in
  the module). Deployment target unchanged (ADR 0003,
  `.verity/deploy-access.md`). Flag: `NIGHTSHIFT_GENERATIVE_UI_ENABLED`
  (house-style rendering of the brief's `GENERATIVE_UI_ENABLED`), default off.

## Frozen integration seam (do not widen)

- Authoring flows ONLY through the control API / `nightshift` CLI — the
  session drives `ui validate|install|list|show|activate|grant|revoke`
  exactly as it drives jobs (ADR 0007). No file-drop path, no daemon LLM.
- Serving flows ONLY through the existing `/app/v1/mcp` door: registry rows
  join `resources/list`; `_meta["ui/tools"]` = granted(name) ∩
  requestedTools(version). Hand-authored `jobs@v1` untouched.
- **app-ingress v1 is not edited** (brief hard requirement). The only
  transport addition is `GET /app/v1/mcp` — the streamable-HTTP spec's own
  notification stream, same bearer + flag gate; certified POST path
  unchanged. ui-bridge.md is not edited; the validator enforces it.
- Generation happens at authoring time only; a page is a persisted versioned
  artifact. Before generating, the assistant checks `nightshift ui list` and
  prefers iterating an existing resource.

## Walking skeleton (feature Stage 0 — blocks the other stages)

Thinnest slice proving the whole spine: chat-side CLI → validator → SQLite →
MCP list.

1. Flag + migration (`ui_resources`, `ui_grants` — safe to apply with flag
   off) + registry module.
2. Validator with the full frozen rule set and verdict shape; test fixtures:
   one known-bad page per rule id, plus `jobs-v1.html` must PASS (drift
   detector against ui-bridge.md).
3. Doors + CLI: `ui validate`, `ui install`, `ui list` (the others come in
   Stage B/C). 422-with-verdict on invalid; nothing registered.
4. MCP mapping: active registry rows in `resources/list` / readable via
   `resources/read`, `_meta["ui/tools"]: []` (no grant machinery yet —
   zero-trust default is the empty list).
5. **CI leg lands here:** flag-on daemon against a scratch DB — install a
   trivial valid fixture via the CLI, assert it lists/reads over MCP with
   empty ui/tools; flag-off run asserts doors 404 and no registry rows; the
   pinned conformance harness green in BOTH flag states.

**Exit:** the DoD's first leg minus the phone: a valid page installs once and
appears in `resources/list` with an empty allowlist; invalid HTML is refused
with a machine-readable verdict; flag off = feature absent; harness green.

## Stage decomposition for the planner

- **A = walking skeleton above.**
- **B — versions & rollback:** `ui install` on an existing name → next
  version, active; `ui show`, `ui activate` (rollback = re-activation);
  `resources/read` serves any exact `@vN`; list advertises active only;
  versions never deleted/edited. Exit: v1→v2→activate-v1 round-trip observed
  over MCP.
- **C — zero-trust grants:** `ui grant`/`ui revoke` doors + durable
  `ui_grants` (approval text, never deleted; revoke sets `revokedAt`);
  intersection rule live in `_meta`; unknown tool names 422. Exit: tool call
  path refused before grant, works after, refused after revoke — observed
  through resource `_meta` and the client-shell allowlist derivation rules.
- **D — list_changed:** `GET /app/v1/mcp` SSE stream, capability
  `resources: { listChanged: true }`, broadcast on register/activate/
  grant/revoke; zero listeners is normal. Exit: a connected GET stream
  receives the notification on each mutation; harness still green.
- **E — assistant authoring flow + live certification:** session-side wiring
  (the assistant knows the verb family, the check-registry-first rule, the
  validate→revise loop, the grant conversation script); deploy dark, flip
  flag, run the brief's DoD from the phone: novel tracker appears with zero
  grants → iteration produces v2 → tool request triggers in-chat approval →
  works after grant, refused before. STATUS.md updated.

## Out of scope (do not plan)

- Ephemeral per-turn UI; nightshift-client changes (live resource-list
  refresh is tracked in the client repo — Stage D's emitter is its server
  half); public web promotion (existing pipeline); memory-graph integration
  (hook honored: registry is queryable via `GET /api/v1/ui/resources`; the
  untracked memory-graph contract + stage-30 draft are the owner's, on hold).

## Drop-in feature catalog

Reviewed (`verity feature list`): only `helper-bot` (In-App Help Agent) —
unrelated to this brief; not pulled in. Request separately via /verity:plan
if wanted.
