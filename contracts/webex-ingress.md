# Contract: webex-ingress

- **Status:** frozen v1
- **Owner:** transport module

## Exposes

- `POST /webhook` — the ONLY publicly exposed route (via cloudflared tunnel; daemon
  binds loopback). Accepts Webex webhook deliveries for `messages/created` (and,
  additively later, attachment/membership events).
- `GET /health` — loopback/tailnet only; liveness for the watchdog. Returns
  `{ ok: true, version, uptimeSec }`.
- **InboundMessage** (event handed to the session manager after verification):
  ```
  {
    schema: 1,
    messageId: string,        // Webex message id (dedup key)
    personId: string,         // real sender, from the FETCHED message, not the webhook body
    text: string,             // plain text of the message
    attachments: string[],    // absolute paths of downloaded files under uploads/<ts>-<name>
    receivedAt: string        // ISO 8601
  }
  ```
- **send(reply)** (outbound helper — the only way any module sends to Webex):
  accepts markdown of any length; chunks at Webex's message-size cap without splitting
  code fences; on send failure delivers a short fallback message and surfaces the error
  (never silent). Accepts optional file attachments.

## Consumes

- Env: `WEBEX_BOT_TOKEN`, `WEBEX_WEBHOOK_SECRET`, `WEBEX_OWNER_PERSON_ID` (all
  required; startup fails fast if any is missing).
- Webex REST API (fetch message body, send messages, download attachments).

## Schema / wire

**Verification (fail closed, in order, before any handling):**
1. Compute HMAC-SHA1 of the raw request body with `WEBEX_WEBHOOK_SECRET`; constant-time
   compare against the `X-Spark-Signature` header. Mismatch or missing header → 401, drop.
2. Secret unconfigured → reject ALL webhook requests (fail closed).
3. Fetch the full message from the Webex API; authorize against the fetched message's
   `personId` == `WEBEX_OWNER_PERSON_ID` (never trust the webhook body's sender).
   Non-owner → 200 (ack), drop silently.
4. Dedup on `messageId` (recently-processed set); duplicates → 200, no re-execution.
5. The bot's own messages → dropped.

**Timing:** the webhook handler acks within Webex's delivery timeout — it enqueues the
InboundMessage and returns 200; all real work happens off the request path.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
