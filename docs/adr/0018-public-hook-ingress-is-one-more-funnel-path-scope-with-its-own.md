# 0018. Public hook ingress is one more Funnel path scope with its own bearer token; app transport stays tailnet-only

- **Status:** Accepted (owner confirmed design choices 2026-10-16)
- **Date:** 2026-10-17
- **Amends:** ADR 0006 (Funnel exposes `/webhook` only) — adds exactly one more
  path scope. **Does not amend** ADR 0011: `/app/v1/*` remains tailnet-only.

## Context

The owner wants to chat with the assistant from callers that are not on the
tailnet: scripts, automation services (Zapier/n8n/Shortcuts), and later
third-party webhooks. Today the only internet-reachable path is the Webex
`/webhook` (ADR 0006), which accepts only Webex-signed deliveries. The app
transport (`/app/v1/*`, ADR 0011) is a full owner surface — chat, uploads,
files, MCP tools including `jobs_submit` — deliberately bound tailnet-only.
Funneling it would put job submission and file serving behind one static token
on the internet, and share that token with the phone.

## Decision

- **A new, chat-only route family `/hook/v1/*`** on the existing loopback
  server (port 3777, alongside `/webhook` and `/api/v1/*`), exposed by **one
  additional Funnel path scope**: `tailscale funnel --set-path /hook/v1
  http://127.0.0.1:3777/hook/v1`. `/api/v1/*` and `/app/v1/*` stay unexposed;
  the port is never Funneled wholesale.
- **Dedicated credential `NIGHTSHIFT_HOOK_TOKEN`** (bearer), distinct from
  `NIGHTSHIFT_APP_TOKEN` and `NIGHTSHIFT_API_TOKEN` — independent rotation,
  independent blast radius. Constant-time compare; 401 precedes 404 on every
  `/hook/v1/` path; token unset with the flag on ⇒ every hook route refuses.
- **Dark by default:** `HOOK_INGRESS_ENABLED` (exact `"true"`) gates route
  registration — flag off ⇒ `/hook/v1/*` falls through to the server's plain
  404, indistinguishable from any unknown path.
- **Chat-only at the wire:** text in, text out. No uploads, no file serving
  (reply `files` are counted, never exposed), no MCP, no job/UI endpoints.
- **Trust level: owner-equivalent, tagged.** The hook token is the owner's
  credential; a hook turn has the same power as the owner messaging the bot
  (including asking it to run jobs). The daemon prefixes the turn text with
  `[via hook: <source>]` so the assistant knows the origin. Treated like a
  password; documented as such.
- **Replies go to the caller only** — synchronously in the HTTP response when
  the turn finishes inside a bounded wait, otherwise via a poll endpoint. The
  turn still lands in the single shared conversational session (memory
  continuity); nothing is mirrored to Webex or the app outbox.
- **Rate limited** (authenticated requests; token bucket + cap on pending hook
  turns) because the relay queue is shared and serialized — a flood would stall
  the owner's Webex/app turns.

## Alternatives considered

- **Funnel `/app/v1` (or a subset of it)** — rejected: exposes MCP/jobs/files
  surfaces, shares the phone's token, and reverses ADR 0011 for no benefit the
  dedicated route doesn't give. A subset Funnel was offered to the owner as a
  stop-gap; the owner chose this ADR instead.
- **HMAC-signed bodies in v1** — deferred (owner choice): bearer works from
  every target caller (curl, Shortcuts, Zapier, n8n). HMAC and per-service
  formats (e.g. GitHub `X-Hub-Signature-256`) arrive as **adapters** under
  `/hook/v1/` in a later stage, each with its own secret, and must frame the
  foreign payload as data, not as owner instructions.
- **cloudflared / separate public host** — rejected for the reasons in ADR 0006;
  Funnel path scoping is already proven on this host.
- **Webex mirror of hook exchanges** — offered, declined by owner for v1.
- **Conversation-only trust (preamble forbids dispatch)** — rejected: one shared
  session means it would be a prompt rule, not a boundary; calling it a
  restriction would overstate it.

## Consequences

- A second internet-reachable door exists. Its safety rests on the token's
  secrecy; a leak is owner-equivalent compromise (agent execution on the host
  via conversation) until `NIGHTSHIFT_HOOK_TOKEN` is rotated. Rotation is one
  `.env` edit + restart and does not touch the phone or CLI.
- The Funnel config lives in tailscaled state; the deploy record
  (`.verity/deploy-access.md`, STATUS.md) gains the `/hook/v1` scope, and
  verification must prove `/api/v1/*` and `/app/v1/*` still 404 at the edge.
- Synchronous waits occupy an HTTP connection behind a serialized queue; the
  wait is bounded and the poll fallback is the real delivery guarantee.
- Future adapters (GitHub, email-forward, etc.) slot in as `/hook/v1/<adapter>`
  without a new Funnel scope.
