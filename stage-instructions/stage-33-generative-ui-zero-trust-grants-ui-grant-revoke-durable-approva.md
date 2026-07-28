# Stage 33: Generative UI zero-trust grants: ui grant/revoke, durable approvals, _meta intersection

- **Type:** feature
- **Depends on:** 31
- **Design:** docs/generative-ui-design.md · ADR 0015 (grant model) ·
  contract: contracts/generative-ui.md (frozen v1)

## Objectives

The zero-trust tool-grant machinery: granting a tool to a generated resource
is an explicit, durably recorded owner-approval act; the resource's
`_meta["ui/tools"]` becomes `granted(name) ∩ requestedTools(version)`.
Before a grant, the tool is absent (the client shell therefore refuses it —
ui-bridge `-32601`); after, it appears; after revoke, it disappears again.
Approval history is never deleted.

## What to build

1. **Registry module:** `grant(name, tool, approvalText)` (idempotent per
   (name, tool) while ungranted-or-revoked; re-grant after revoke = new row),
   `revoke(name, tool)` (sets `revoked_at`; rows never deleted),
   `grantedTools(name)` (active, unrevoked), and the intersection computation
   used by the MCP mapping and by `UiResourceRecord.grantedTools`.
2. **Control doors:** `POST /api/v1/ui/grants` body `{ name, tool,
   approvalText }` and `POST /api/v1/ui/grants/revoke` body `{ name, tool }`
   per the frozen contract. Unknown resource name → 404; tool name not in the
   MCP TOOLS catalog → 422. Flag off → 404.
3. **CLI verbs:** `ui grant <name> <tool> --approval <text>`,
   `ui revoke <name> <tool>`. The `--approval` text is the owner's in-chat
   approval message — the durable record the brief requires.
4. **MCP mapping:** replace Stage 31's constant `[]` with the intersection,
   evaluated at BOTH `resources/list` and `resources/read` time. Grants
   attach to the NAME (ADR 0015): iteration keeps approved tools; a version
   requesting an ungranted tool simply doesn't carry it until granted.
5. **Hand-authored `jobs@v1` is untouched** — its static allowlist does not
   consult the grants table (brief: hand-authored resources unaffected).

## Interface contracts

- **Exposes:** the grants subset of contracts/generative-ui.md; the
  intersection rule Stages 34–35 and the client shell's allowlist derivation
  rely on.
- **Consumes:** Stage 31's registry/doors/flag; the frozen MCP TOOLS names
  (`src/transport/app/mcp.ts`) as the grantable universe;
  contracts/app-ingress.md and ui-bridge.md unedited.

## Testing requirements

- Lifecycle integration test: install page requesting `jobs_list` →
  `resources/list` `_meta["ui/tools"]: []` → grant → `["jobs_list"]` →
  revoke → `[]` → re-grant → `["jobs_list"]`; grants table shows the full
  history (revoked row retained with `revoked_at`, new row after re-grant).
- Intersection: page requests `[jobs_list, jobs_kill]`, only `jobs_list`
  granted → `_meta` carries exactly `["jobs_list"]`; grant of a tool NOT in
  the version's requested set is recorded but does not appear in `_meta`
  (name-level grant, version-level intersection).
- Validation: unknown tool name 422; unknown resource 404; `jobs@v1` `_meta`
  byte-identical to Stage 28 regardless of grants table contents.
- Conformance harness green in both flag states.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature
      (Stage 31's flag — no second flag)
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (extend docs/smoke/: grant → _meta appears → revoke → gone)
- [ ] Additive migration only (no destructive schema change — expected: NO new
      migration; 0009 already carries `ui_grants`)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
