# 0015. SQLite UI registry with per-name grants, version rollback, and list_changed over an MCP GET stream

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

Generated resources must be persisted with name, version, HTML, granted
tools, provenance, and created_at; `resources/list` must reflect the
registry; `notifications/resources/list_changed` must be emitted on register;
prior versions must remain for rollback; and grants are zero-trust
owner-approval steps recorded durably. Three sub-decisions interact: where
the registry lives, what a grant attaches to across versions, and how a
stateless JSON-per-POST MCP endpoint (ADR 0012) can "emit" a notification at
all.

## Decision

- **Registry in SQLite** (ADR 0004 — one schema source, migration-ledger):
  migration adds `ui_resources(id, name, version, html, requested_tools JSON,
  provenance, created_at, active)` and `ui_grants(id, name, tool,
  approval_text, granted_at, revoked_at NULL)`. All versions are retained;
  exactly one `active` version per name.
- **Versioning & rollback:** `ui install` for an existing name assigns the
  next version and makes it active; `ui activate <name> <v>` flips the active
  pointer (rollback is re-activation, never deletion). `resources/list`
  advertises the ACTIVE version per name; `resources/read` serves any exact
  `@vN` uri (a listed client can always read what it saw listed, and rollback
  needs the old bytes).
- **Grants attach to the NAME, not the version.** Effective allowlist for a
  version = `granted(name) ∩ requested_tools(version)`. So: a fresh resource
  starts empty (zero-trust); iteration ("make the buttons bigger") keeps
  already-approved tools without re-prompting; a version requesting a tool
  never granted surfaces the approval ask, and until granted that tool is
  simply absent from `_meta["ui/tools"]`. Revocation (`ui revoke`) is
  immediate across all versions of the name. Grant rows are never deleted —
  revocation sets `revoked_at`, so the approval history stays durable.
- **`list_changed` over a standard streamable-HTTP GET stream.** POST
  `/app/v1/mcp` stays stateless JSON (ADR 0012). The MCP streamable-HTTP
  transport spec already defines GET on the same endpoint as an optional SSE
  stream for server-initiated messages: we mount `GET /app/v1/mcp` under the
  same bearer/flag gate, declare `resources: { listChanged: true }`, and
  broadcast `notifications/resources/list_changed` to whatever GET streams
  are open (zero is fine — the notification is best-effort by spec) on
  register, activate, grant, and revoke. No app-ingress v1 change: the pinned
  contract's mcp door is "streamable-HTTP MCP (official TS SDK)", and the GET
  stream is part of that transport, not a new route shape.
- **Hand-authored resources are unaffected:** `ui://nightshift/jobs@v1` stays
  file-shipped with its static allowlist (ADR 0012); the registry contributes
  additional rows only when `NIGHTSHIFT_GENERATIVE_UI_ENABLED=true`.

## Alternatives considered

- **HTML files in the data dir, DB for metadata only** — rejected: two
  stores to back up and keep consistent; single-file SQLite state is the
  standing decision (ADR 0004), and pages are ≤256 KB text — well within
  comfortable BLOB/TEXT territory.
- **Grants per version** — rejected: re-approving `jobs_list` on every
  "make the buttons bigger" iteration trains the owner to click yes; the real
  risk is a NEW capability, which per-name ∩ per-version requested_tools
  still forces through explicit approval.
- **Grants inherited wholesale by new versions regardless of requested set**
  — rejected: a v2 could silently carry a dangerous tool it no longer needs;
  the intersection keeps the allowlist minimal per version.
- **Deliver list_changed via the app_outbox `notice` events** — rejected: those
  are chat-surface events with the AssistantReply/notice shapes; smuggling
  JSON-RPC into them changes app-ingress v1 semantics, which the brief
  forbids. (The owner still hears "installed habit-tracker@v1" in chat as a
  normal reply — that's conversation, not protocol.)
- **Long-lived stateful MCP sessions** (sessionIdGenerator + per-session
  streams) — rejected: ADR 0012's stateless posture is what the pinned
  conformance harness certifies; a GET-only notification stream adds push
  without touching the certified POST path.

## Consequences

- One migration, no new stores; backup story unchanged (copy the SQLite
  file). The registry is queryable through the control doors — the future
  memory-graph integration reads it without schema archaeology.
- The client today ignores the GET stream (live resource-list refresh is
  tracked separately in the client repo); when it arrives, the daemon side is
  already emitting. Until then the Apps tab refreshes on reconnect/re-list —
  acceptable for the DoD's "screen appears" (the owner is told in chat when
  it's ready).
- `resources/list` growth is bounded by distinct names, not versions.
- The conformance harness must stay green with the GET route mounted: harness
  runs with the flag off exercise the certified surface unchanged; a
  flag-on harness run is part of the feature's stage exits.
