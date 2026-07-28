# Stage 35: Generative UI authoring flow live: session wiring, deploy dark, certify the phone DoD

- **Type:** feature
- **Depends on:** 31,32,33,34
- **Design:** docs/generative-ui-design.md · ADR 0013 (authoring flow) ·
  contract: contracts/generative-ui.md · brief DoD (the phone script)

## Objectives

The owner can do the whole thing from the phone, in chat: request a novel
tracker → it appears in the Apps tab functioning with zero granted tools;
request a change → v2 appears; request a page that wants a tool → in-chat
approval → the tool works after the grant and is refused before it. Deployed
dark, flag flipped deliberately, certified live, STATUS.md updated.

## What to build

1. **`GENERATIVE_UI_PREAMBLE`** in `src/session/manager.ts`, appended behind
   `config.controlEnabled && config.generativeUiEnabled` (exact pattern of
   PROMOTE/REMARKABLE preambles — a dark feature is not advertised). It must
   teach, tersely and imperatively:
   - the model: generate ONCE at authoring time; pages are persisted
     versioned artifacts fed by their declared tools; NEVER regenerate per
     interaction;
   - reuse-first (brief hard requirement): before generating, run
     `nightshift ui list` and prefer iterating an existing resource
     (`ui install` under the SAME name → next version);
   - authoring rules: single self-contained HTML per
     nightshift-client/contracts/ui-bridge.md — no network/storage/
     navigation, postMessage JSON-RPC bridge only, signal `ui/ready`, render
     degradably with static markup; size ≤ 256 KB;
   - the loop: write HTML to a temp file → `nightshift ui validate <file>` →
     revise on violations → `nightshift ui install <file> --name <n>
     [--tools ...] --provenance "<the owner's request, quoted>"` → tell the
     owner it's in the Apps tab;
   - grants: tools NEVER work until granted; when a page requests tools, ask
     the owner explicitly in chat ("this page requests jobs_kill — allow?")
     and on approval run `nightshift ui grant <name> <tool> --approval
     "<owner's message verbatim>"`; on refusal, leave ungranted and say what
     won't work; `nightshift ui revoke` on request;
   - rollback: `nightshift ui show <name>` / `nightshift ui activate <name>
     <version>` when the owner dislikes a version.
2. **Config/env plumbing** for the deploy: `.env.example` (or the deploy
   checklist's env enumeration) gains `NIGHTSHIFT_GENERATIVE_UI_ENABLED`,
   default off; systemd unit untouched (env file driven).
3. **Deploy dark + certify live** (Stage 29's playbook): ship with the flag
   off; verify feature absent (doors 404, MCP list unchanged); flip the flag;
   run the DoD script below from the owner's phone; record results in
   STATUS.md and the ops commit.

## Interface contracts

- **Exposes:** nothing new on the wire — this stage is the consumer of
  contracts/generative-ui.md end to end.
- **Consumes:** Stages 31–34 complete; contracts/assistant-session.md (the
  preamble rides the existing spawn shape — no session contract change);
  contracts/generative-ui.md; ui-bridge.md (authoring rules cited in the
  preamble).

## Testing requirements

- Unit: preamble present only when both flags on (mirror the existing
  preamble gating tests); preamble text references only verbs that exist in
  `bin/nightshift`.
- **Live certification script** (authored as `docs/smoke/generative-ui.md`,
  run by the Operator/owner on the phone, results recorded):
  1. Flag off: Apps tab shows only jobs dashboard; `ui` verbs refuse.
  2. Flag on, in chat: "make me a habit tracker with big buttons" →
     assistant lists registry, generates, validates, installs → resource in
     Apps tab, renders, zero granted tools (any tools/call → refused by
     shell).
  3. "make the buttons bigger" → v2 appears (same name, next version);
     `ui show` lists both; rollback to v1 works.
  4. Request a page needing a tool (e.g. "show my jobs and let me kill
     them") → approval prompt in chat → before approval the tool is absent
     (`_meta` empty / shell -32601); after `ui grant`, the tool works.
  5. Harness green against the live daemon, flag on.
- CI: full suite + conformance harness green in both flag states (inherited
  gates; no new CI legs expected).

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature
      (Stage 31's flag; this stage proves flag-off = feature absent LIVE)
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (docs/smoke/generative-ui.md above — the DoD script)
- [ ] Additive migration only (no destructive schema change — expected: none)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
