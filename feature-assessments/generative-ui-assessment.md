# Feature assessment: Generative UI resources ("ask, and the screen appears")

- **Date:** 2026-07-28 · **Role:** Intake/Planner (Mode A over
  docs/generative-ui-design.md, from the owner's feature brief)
- **Decision:** ACCEPT, SPLIT into stages 31–35 (dependency-ordered).
- **Design inputs:** ADRs 0013/0014/0015 · frozen contracts/generative-ui.md

## Request

The assistant authors its own mobile screens on request in chat: generate a
single-file HTML resource, validate it against the ui-bridge contract,
persist it versioned (`ui://nightshift/<name>@v<N>`), register it over MCP so
it appears in the phone's Apps tab with no client release. Iteration → next
version; rollback retained. Zero-trust tool grants with in-chat approval.
Flagged, default off. Generate once / install / reuse — never per
interaction.

## Claim/reality verification (against live source)

| Claim in brief/design | Reality | Verdict |
|---|---|---|
| MCP door exists with tools + one UI resource | `src/transport/app/mcp.ts`: five tools, `ui://nightshift/jobs@v1` file-served, `_meta["ui/tools"]` on descriptor and read | ✅ |
| Registering more resources is additive within `mcp-apps-ui` | `resources/list`/`read` handlers are local to `buildServer()`; app-ingress.md names the door, not the resource count | ✅ |
| `notifications/resources/list_changed` can be "emitted" | POST path is stateless JSON (`server.ts:529` region 405s non-POST). SDK 1.30.0 HAS `sendResourceListChanged()`; streamable-HTTP spec's optional GET SSE stream is the channel — ADR 0015 | ✅ with design (Stage 34) |
| Control API accepts additive doors | Precedent: stages 10/11/19 added `/api/v1/deliver|promote|remarkable` additively on frozen control-api v1 | ✅ |
| CLI can grow a `ui` verb family | `bin/nightshift` flat case dispatch | ✅ |
| SQLite + migration ledger | `migrations/0001–0008`; next is 0009 | ✅ |
| Flag house style | `src/config.ts` strict "true"/"false" validation pattern | ✅ (`NIGHTSHIFT_GENERATIVE_UI_ENABLED`) |
| Session can be taught the flow | `manager.ts:447`: per-capability preambles behind flags (CONTROL/PROMOTE/REMARKABLE/types) | ✅ (Stage 35 preamble) |
| jobs-v1.html usable as validator must-pass fixture | 471 lines, no `fetch`/`localStorage`/`window.open` hits | ✅ |
| ui-bridge contract available to enforce | `~/projects/nightshift-client/contracts/ui-bridge.md`, frozen v1, shell-side sandbox + allowlist semantics | ✅ |

No false premises found; the one real design tension (stateless MCP vs
list_changed) is resolved in ADR 0015 without editing app-ingress v1.

## Contract safety

- **New seam:** contracts/generative-ui.md (frozen v1 by the Architect) —
  the doors, CLI verbs, registry schema, validator verdict/rule ids, MCP
  mapping, grant model.
- **Frozen contracts threatened:** none edited. control-api v1 extended
  additively (precedented); app-ingress v1 untouched (GET /app/v1/mcp is the
  named transport's own optional stream, ADR 0015); ui-bridge.md consumed,
  not changed; assistant-session untouched (preamble rides the existing
  spawn shape). Conformance harness must stay green in both flag states —
  wired into every stage's exits.

## Split rationale

- **31 — walking skeleton** (blocks all): flag, migration 0009 (both
  tables), registry module, full validator rule set + fixtures, validate/
  install/list doors + CLI, MCP listing with `_meta: []`. Proves the whole
  spine incl. CI legs on day one.
- **32 — versions & rollback** (dep 31): next-version install, show/
  activate, read any `@vN`, one-active-per-name invariant.
- **33 — zero-trust grants** (dep 31): grant/revoke doors, durable
  never-deleted approvals, `granted(name) ∩ requested(version)` in `_meta`.
  Parallel-safe with 32 (touches grants + `_meta` computation, not the
  version paths).
- **34 — list_changed** (dep 31,32,33): GET stream + broadcaster wired into
  all four mutation points at once — after they all exist, so emission
  coverage is reviewed in one place.
- **35 — authoring flow live** (dep 31–34): session preamble (reuse-first,
  validate→revise loop, grant conversation), deploy dark, flip, certify the
  brief's DoD from the phone, STATUS.md.

## Out of scope (held)

Ephemeral per-turn UI; nightshift-client changes (live refresh consumes
Stage 34's emitter later, from the client repo); public web promotion;
memory-graph integration — hook honored via the queryable registry door; the
untracked memory-graph contract + stage-30 draft are the owner's, on hold.
