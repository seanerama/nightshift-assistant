# Stage 39: Hook ingress: public chat door /hook/v1 with dedicated token, sync-or-poll replies, rate limit (dark)

- **Type:** feature
- **Depends on:** none (builds on the shipped transport server + relay seam)
- **Design:** ADR 0018 · contract `contracts/hook-ingress.md` v1 ·
  feature-assessments/hook-ingress-assessment.md · Issue #88

## Objectives

The owner can chat with the assistant from any HTTP caller with one request:
`POST /hook/v1/messages` with a bearer token returns the assistant's reply in
the response (or a poll handle when the turn outlasts the wait). Chat-only,
its own credential, rate limited, dark by default. This stage ships the code
dark; stage 40 deploys, Funnels and certifies it.

## What to build

1. **`src/transport/hook.ts`** — `createHookHandler(deps)` returning
   `(req, res) => Promise<void>` for paths under `/hook/v1/`. Deps: `config`,
   `log`, `db`, `relay: (msg: InboundMessage) => Promise<AssistantReply>`,
   `now?` (test seam). Implements the contract exactly:
   - Auth first on every path (401 before 404/405/400/413). Reuse the
     SHA-256 + `timingSafeEqual` pattern — **extract** the duplicated private
     `tokenMatches` (`src/transport/api.ts:70-78`, `src/transport/app/server.ts:116-124`)
     into one exported helper (e.g. `src/transport/auth.ts`) and use it from all
     three; behavior of the existing two must not change.
   - Rate limiting: small in-memory token-bucket module (no new dependency),
     applied to authenticated requests only; separate buckets for POST and GET;
     `HOOK_MAX_PENDING` check on POST. 429 + `Retry-After`.
   - Body: read with a 16 KiB cap (own cap, not the shared 1 MiB) → 413; JSON
     parse/validation → 400 with a short reason.
   - Builds the `InboundMessage` per contract (`hook:` id prefix, owner
     personId, `[via hook: <source>]\n` text prefix, no attachments).
   - Durable state in `hook_messages`: insert `pending` → enqueue
     `relay()` (not awaited by the request) → on resolve write `completed` +
     reply text/rotated/filesOmitted; on reject write `failed`. The request
     awaits the turn's promise up to `wait` seconds (race with a timer), then
     answers 200 or 202. The turn always runs to completion regardless of the
     HTTP outcome (client disconnects do not cancel it).
   - Idempotent re-POST of an existing `messageId` returns current state, no
     new turn. `GET /hook/v1/messages/<id>` per contract.
   - Retention prune (completed/failed older than `HOOK_RETENTION_DAYS`) on insert.
   - Logs: messageId, source, status, latencyMs, http code only — never token,
     text or reply.
2. **`migrations/0011_hook_messages.sql`** (additive): `hook_messages(message_id
   TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN
   ('pending','completed','failed')), reply_text TEXT, rotated INTEGER,
   files_omitted INTEGER, created_at TEXT NOT NULL, completed_at TEXT)` + index on
   `created_at`; must end with its own `schema_version` insert (runner requirement).
3. **Boot reconciliation** — at startup, mark any `pending` hook row `failed`
   with the contract's "lost: the daemon restarted…" text.
4. **`src/config.ts`** — `HOOK_INGRESS_ENABLED` via the existing exact-`"true"`
   flag parser; `NIGHTSHIFT_HOOK_TOKEN` read like `NIGHTSHIFT_APP_TOKEN` (not
   validated in config); integer tunables with the contract defaults and sane
   bounds (`HOOK_MAX_WAIT_SEC` ≤ 120, `HOOK_DEFAULT_WAIT_SEC` ≤ max).
5. **`src/transport/server.ts` + `src/app.ts`** — inject the hook handler as an
   optional dep (same shape as `api?`), dispatched on the `/hook/v1/` prefix
   next to the `/api/v1/` check. Flag off ⇒ handler not injected ⇒ existing 404.
   Flag on + empty token ⇒ handler injected but refuses everything (401) and
   `app.ts` logs an error once at startup (mirror `app.ts:112-124` fail-closed
   style; daemon keeps running).
6. **Docs** — `docs/ARCHITECTURE.md` transport section: the third door, its
   trust level (owner-equivalent; token = password), and exposure (`/hook/v1`
   Funnel scope only). `.env.example`:
   the new names, no values. Author `docs/smoke/hook-ingress.md` (the live smoke
   stage 40 runs — see Testing).

Out of scope (do not build): HMAC/per-service adapters, outbound webhooks /
callback URLs, attachments or file serving, Webex mirroring, any change to
`/app/v1/*` or `/api/v1/*` behavior, the Funnel change itself (stage 40).

## Interface contracts

- **Exposes:** `contracts/hook-ingress.md` v1 (frozen) — `/hook/v1/messages`
  POST + GET. Nothing else.
- **Consumes:** `contracts/assistant-session.md` (the `relay()` seam, unchanged;
  hook messages queue with every other turn), `contracts/webex-ingress.md` /
  `contracts/app-ingress.md` (unchanged — must not regress), ADR 0018, 0011, 0006.

## Testing requirements

- `test/hook.test.ts` (Vitest; `createApp` + `app.listen()` on port 0 like
  `test/ack.test.ts`, stub agent per `test/helpers.ts`):
  - flag off ⇒ `/hook/v1/messages` 404, identical body to an unknown path;
  - flag on, no/wrong token ⇒ 401 on POST, GET, unknown `/hook/v1/x` and bad
    method (401 precedes 404/405); flag on + token unset ⇒ 401 everywhere;
  - happy path: POST with token returns 200 `completed` with the stub's reply;
    the stub received text prefixed `[via hook: hook]` and owner personId;
    `source` label is applied; invalid `source` ⇒ 400;
  - slow stub + `wait:1` ⇒ 202 `pending` + poll path; GET later ⇒ `completed`;
    `wait:0` ⇒ immediate 202;
  - idempotency: same `messageId` twice ⇒ one relay call, same result;
  - 413 over 16 KiB; 400 on bad JSON / empty text / text > 8000 / bad wait;
  - rate limit: burst exceeded ⇒ 429 with `Retry-After`; pending cap ⇒ 429;
    unauthenticated requests do not consume the bucket;
  - reply with `files` ⇒ `filesOmitted` count, no paths in the body;
  - boot reconciliation: a pre-seeded `pending` row becomes `failed`;
  - logs (captured logger) never contain the token, text or reply text.
- Extracted `tokenMatches` helper: existing `test/api.test.ts` and app
  transport auth tests stay green unchanged.
- Migration test: fresh DB migrates to version 11; existing migration tests green.
- `docs/smoke/hook-ingress.md` — the live, off-tailnet smoke: 401 without
  token; 200 sync reply; 202 + poll on `wait:0`; idempotent re-POST; 429 after
  burst; `/api/v1/status`, `/app/v1/health` and `/health` all **404 at the
  Funnel edge**; one Webex message still round-trips afterwards.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature
      (`HOOK_INGRESS_ENABLED`; flag off = routes absent, proven by test)
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (`docs/smoke/hook-ingress.md`, executed in stage 40)
- [ ] Additive migration only (no destructive schema change) — `0011_hook_messages.sql`
- [ ] Contract `contracts/hook-ingress.md` v1 implemented exactly (auth order,
      shapes, status codes, defaults)
- [ ] No change in behavior of `/webhook`, `/app/v1/*`, `/api/v1/*`
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
