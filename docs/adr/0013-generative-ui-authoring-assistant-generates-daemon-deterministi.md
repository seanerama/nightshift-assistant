# 0013. Generative UI authoring: assistant generates, daemon deterministically validates and registers

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

The Generative UI feature brief ("ask, and the screen appears") lets the owner
request a mobile screen in chat; the assistant produces a single-file HTML
resource that appears in the phone app's Apps tab as a versioned
`ui://nightshift/<name>@v<N>` MCP resource. Something has to generate the HTML,
something has to gate it (validator, zero-trust grants), and something has to
persist and serve it. The daemon's standing posture is that it contains **no
LLM calls of its own** — the conversational session is the intelligence, and it
drives the daemon only through the `nightshift` CLI over the control API
(ADR 0007), while daemon-resident behavior stays deterministic (ADR 0008 made
the same cut for promotion).

## Decision

- **Generation happens in the assistant session, at authoring time only.** The
  session (which is already an LLM in a chat loop) authors the HTML itself.
  The daemon never calls a model. A generated page is a persisted artifact
  that thereafter receives only data through its declared tools — never
  regenerated per interaction. Before generating, the assistant queries the
  registry (`nightshift ui list`) and prefers iterating an existing resource.
- **The daemon owns validation, persistence, registry, and serving** — all
  deterministic code: validate the HTML (ADR 0014), assign the next version,
  record provenance, store in SQLite (ADR 0015), and reflect the registry in
  MCP `resources/list`.
- **The seam is additive control-API doors + CLI verbs**, frozen in
  `contracts/generative-ui.md`: `nightshift ui validate|install|list|show|
  activate|grant|revoke` over `/api/v1/ui/*`. The conversational session uses
  ONLY the CLI, exactly as for jobs — no new pathway for the assistant to
  touch daemon state.
- **Owner approval stays in chat.** The grant conversation ("this page
  requests jobs_kill — allow?") happens in the session; the assistant records
  the outcome durably via `nightshift ui grant`, quoting the owner's approval
  message as provenance. The daemon enforces: no grant row → tool absent from
  the resource's `_meta["ui/tools"]`.
- **Kill switch:** `NIGHTSHIFT_GENERATIVE_UI_ENABLED` (house-style name for
  the brief's `GENERATIVE_UI_ENABLED`), default off, validated like every
  other flag. Off = the `/api/v1/ui/*` doors, CLI verbs, and registry-backed
  resources are absent; the hand-authored `ui://nightshift/jobs@v1` is
  unaffected.

## Alternatives considered

- **Daemon-resident generation** (daemon calls a model API on request) —
  rejected: introduces a second LLM surface with its own credentials, retries,
  and prompt management, and breaks the "daemon is deterministic; the session
  is the intelligence" architecture (ADRs 0007/0008). The session is already
  where the owner's request, context, and iteration loop live.
- **Generate per interaction** (fresh page each time the owner opens it) —
  rejected by the brief's model: generate once, install, reuse. Per-turn
  generation makes every open nondeterministic, unauditable, and slow.
- **A separate authoring service** — rejected: modular monolith
  (ADR 0001); a new service multiplies CI/images/deploy surface for a
  feature that is a validator plus a table.
- **Assistant writes files into a watched directory** instead of API doors —
  rejected: bypasses auth, validation ordering, and the single control plane;
  the CLI/control-API seam already exists and is contract-frozen.

## Consequences

- Generation quality is the session's concern (prompting, ui-bridge
  conventions); the daemon's gate is the only line that matters for safety
  and registry integrity — it must reject invalid HTML regardless of how it
  was produced.
- The validator's reject-with-reasons shape becomes part of the contract, so
  the assistant can revise-and-resubmit mechanically.
- Because authoring flows through the control API, everything works from any
  chat surface (phone app, Webex) with zero client changes, and behavior
  parity with a human driving `nightshift ui ...` by hand is by construction.
- The registry stays queryable through the same doors — the future
  memory-graph integration (out of scope now) reads it without a new seam.
