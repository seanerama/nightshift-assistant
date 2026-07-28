# 0014. UI validator is deterministic static analysis; the client shell sandbox remains the security boundary

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Generated HTML MUST pass an automated validator enforcing the ui-bridge
contract (`nightshift-client/contracts/ui-bridge.md`) before registration:
single self-contained file, no network/storage/navigation attempts,
postMessage JSON-RPC only, renders degradably. The validator's verdict gates
`ui install` — reject means the assistant revises; an invalid resource is
never registered. The question is what kind of checker this is: static
analysis, full JS interpretation, or sandboxed execution — and what security
weight it carries.

## Decision

- **The validator is deterministic static analysis** in the daemon: parse the
  HTML, then scan it and every inline `<script>`/handler against a frozen,
  additive **rule set** (rule ids are contract surface,
  contracts/generative-ui.md):
  - single self-contained file — no external `src`/`href`/`@import`/URL
    references that would fetch (data: URIs allowed);
  - no network identifiers (`fetch`, `XMLHttpRequest`, `WebSocket`,
    `EventSource`, `navigator.sendBeacon`, `import(`);
  - no storage identifiers (`localStorage`, `sessionStorage`, `indexedDB`,
    `document.cookie`, `caches`);
  - no navigation (`window.open`, `location` assignment, `<a href>` to
    external targets, `<form action>`, meta refresh);
  - bridge shape: talks only via the ui-bridge postMessage JSON-RPC and
    signals `ui/ready`;
  - degradable render: a non-empty static `<body>` exists without any tool
    result (markup present, not a script-built-only `<body>`);
  - size cap (256 KB) and well-formedness.
- **Conservative by design: reject on suspicion.** A banned identifier
  anywhere in script text is a violation even if unreachable. False rejects
  cost one revise round-trip; false accepts cost registry pollution. There is
  no override path.
- **Verdict shape is frozen:** `{ valid, violations: [{ rule, detail }] }` —
  machine-readable so the assistant's revise loop is mechanical, and exposed
  standalone (`nightshift ui validate`) so revision doesn't consume version
  numbers.
- **The validator is a quality/honesty gate, not the security boundary.** The
  ui-bridge contract already binds the client shell to enforce the sandbox at
  runtime: one WebView per resource, external navigation blocked, no token in
  the WebView, non-allowlisted `tools/call` → `-32601`, mandatory fallback
  render. Validator bypasses are therefore contained, not catastrophic —
  defense-in-depth, with the shell as the load-bearing wall.

## Alternatives considered

- **Headless-browser execution** (load the page, observe behavior) —
  rejected: a heavy runtime dependency on the deploy host, nondeterministic
  verdicts (timing, versions), and it still can't prove absence of behavior —
  only static analysis gives a stable, reviewable rule set.
- **Full JS AST analysis** (parser + data-flow) — rejected for v1: real
  parsers still can't defeat dynamic evaluation (`window['fet'+'ch']`), so
  the marginal soundness over identifier scanning is small while the
  dependency and rule-authoring cost is large. The rule set is additive — an
  AST-based rule can arrive later without a contract break.
- **Validator as the security boundary** (treat passing HTML as trusted) —
  rejected: static analysis of untrusted-shaped input cannot be sound; the
  shell sandbox already exists and is contract-bound. Assigning security
  weight to the validator would demand soundness it cannot deliver.
- **LLM-as-validator** (a session judges the HTML) — rejected:
  nondeterministic gate on the registry write path; violates ADR 0013's
  "daemon is deterministic".

## Consequences

- The validator can reject legitimate pages (e.g. a string literal containing
  the word `fetch` in help text). Accepted cost: the violation names the rule
  and offending text, and the assistant rewrites; rules can be refined
  additively if a pattern proves too noisy.
- The rule set is enforceable in CI: the test suite feeds known-bad fixtures
  (one per rule) and the hand-authored jobs dashboard (must pass) — drift
  between validator and ui-bridge contract shows up as a red fixture.
- If the client repo revises ui-bridge.md, the rule set follows at its next
  additive revision, never silently (same discipline as ADR 0012's resource
  provenance).
- Runtime dependency stays boring: an HTML tokenizer at most — no browser,
  no model.
