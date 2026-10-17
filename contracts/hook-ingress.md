# Contract: hook-ingress

- **Status:** frozen v1
- **Owner:** transport module (`src/transport/hook.ts`)
- **Design:** ADR 0018 (amends ADR 0006's Funnel scope; ADR 0011 unchanged)

## Exposes

All routes under `/hook/v1/`, served by the existing loopback transport server
(`127.0.0.1:<NIGHTSHIFT_PORT>`, default 3777), registered ONLY when
`HOOK_INGRESS_ENABLED=true` (flag off = routes absent → the server's ordinary
404). Public reach is exactly one Funnel path scope, `/hook/v1`.

- `POST /hook/v1/messages` — submit one chat turn; returns the reply
  synchronously when it completes within the wait, otherwise a poll handle.
- `GET /hook/v1/messages/<messageId>` — current state of a submitted turn.

Nothing else. No uploads, no file serving, no MCP, no job/UI/control endpoints.

## Consumes

- The frozen seam only: `InboundMessage → relay() → AssistantReply`
  (contracts/assistant-session.md). The hook transport awaits `relay()` itself
  and owns its reply (same pattern as Webex and app transports). It registers
  **no** proactive `send()` sink — notices keep flowing to Webex + app outbox.
- Config: `HOOK_INGRESS_ENABLED`, `NIGHTSHIFT_HOOK_TOKEN` (host `.env`, generated
  at deploy, distinct from the app and API tokens), the configured owner person
  id (existing), and tunables below.
- SQLite (ADR 0004): table `hook_messages` (migration `0011_hook_messages.sql`).

## Schema / wire

**Auth (fail closed, in order) — every `/hook/v1/` request:**
1. `Authorization: Bearer <NIGHTSHIFT_HOOK_TOKEN>`; constant-time compare.
   Missing/wrong ⇒ **401** `{ ok:false, error:"unauthorized" }`. **401 precedes
   404/405/400** — the surface is not enumerable without the token.
2. Token unset while the flag is on ⇒ every hook route 401 (and a startup error
   log); the daemon keeps running.
3. Rate limit (authenticated requests only) ⇒ **429** with `Retry-After` (seconds).

**`POST /hook/v1/messages`** — `content-type: application/json`, body ≤ 16 KiB
(else **413**):

```json
{
  "text": "string, 1..8000 chars, required",
  "source": "optional label ^[a-z0-9][a-z0-9._-]{0,31}$, default \"hook\"",
  "messageId": "optional caller idempotency key ^[A-Za-z0-9._:-]{1,128}$; server generates a UUID when absent",
  "wait": "optional integer seconds 0..HOOK_MAX_WAIT_SEC, default HOOK_DEFAULT_WAIT_SEC"
}
```

Invalid body ⇒ **400** `{ ok:false, error:<reason> }`.

The daemon builds `InboundMessage { schema:1, messageId:"hook:"+messageId,
personId:<configured owner>, text:"[via hook: <source>]\n"+text,
attachments:[], receivedAt:<now> }` and enqueues `relay()`.

Responses (`messageId` echoes the caller's key, without the `hook:` prefix):

- **200** — completed within the wait:
  `{ ok:true, status:"completed", messageId, reply:{ text, rotated, filesOmitted } }`
- **202** — still running (or `wait:0`):
  `{ ok:true, status:"pending", messageId, poll:"/hook/v1/messages/<messageId>" }`
- **200** `status:"failed"` — the turn was lost (daemon restart) or `relay()`
  rejected despite its never-throws contract (defensive). An in-band error reply
  from `relay()` (e.g. "The assistant session hit an error…") is a normal
  `completed` reply — `relay()` exposes no error flag and this contract adds none.
- Re-POST of an existing `messageId` starts **no** new turn; it returns that
  message's current state (200/202 as above) — durable idempotency.

`filesOmitted` = `AssistantReply.files.length`. Local paths are never returned.

**`GET /hook/v1/messages/<messageId>`** ⇒ 200 with the same `{ ok, status,
messageId, reply? }` shape; unknown id ⇒ **404** `{ ok:false, error:"not found" }`
(only after auth).

**Status values:** `pending | completed | failed`. A row still `pending` at
daemon start is marked `failed` with reply text "lost: the daemon restarted
before this turn finished" (the turn cannot be resumed).

**Tunables (env, with defaults):** `HOOK_DEFAULT_WAIT_SEC=25`,
`HOOK_MAX_WAIT_SEC=55`, `HOOK_RATE_PER_MIN=6` with burst 3 for POST,
`HOOK_POLL_RATE_PER_MIN=60` for GET, `HOOK_MAX_PENDING=3` (POST ⇒ 429 while
that many hook turns are pending), `HOOK_RETENTION_DAYS=7` (completed/failed
rows older than this are pruned on insert).

**Logging:** messageId, source, status, latency, HTTP code. Never the token,
never the text or reply.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
Future adapters (e.g. GitHub HMAC) are additive routes under `/hook/v1/<adapter>`
with their own secrets, recorded as an amendment here.
