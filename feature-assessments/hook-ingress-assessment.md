# Feature assessment: hook ingress (public chat door for non-tailnet callers)

- **Date:** 2026-10-16 · **Role:** Intake/Planner (Mode B, owner request)
- **Decision:** **ACCEPT, SPLIT into stages 39 (feature, dark) → 40 (chore,
  deploy + Funnel + certify)**.
- **Design inputs:** new ADR 0018 (amends ADR 0006 scope; ADR 0011 unchanged);
  new frozen contract `contracts/hook-ingress.md` v1.

## Request

Owner wants to interact with the bot "via api or webhook directly" from callers
outside the tailnet, using Tailscale Funnel. Of the two options presented
(Funnel a subset of `/app/v1` as a stop-gap vs. a dedicated public route), the
owner chose the dedicated route.

**Owner design choices (confirm-gate, 2026-10-16):**
1. Auth v1 = **bearer token** (`NIGHTSHIFT_HOOK_TOKEN`); HMAC/per-service
   adapters deferred.
2. Replies go to the **caller only** (no Webex mirror).
3. Trust = **owner-equivalent, tagged** — `[via hook: <source>]` prefix.

## Claim / reality verification (against live source, 2026-10-16)

| Claim | Reality |
|---|---|
| Today only Webex is public | ✅ Live Funnel on 3090-tuf: `/webhook` → 127.0.0.1:3777 (+ unrelated `/csweet/webhook` → 3778). `/app/v1` binds 127.0.0.1 + tailnet IP on 3779, not Funneled (ADR 0011). |
| A new route can live beside `/webhook` | ✅ `src/transport/server.ts:216-240` if-chain on one loopback `node:http` server; `/api/v1/` is an injected optional dep (`server.ts:35,87`) — `/hook/v1/` plugs in the same way. Unknown paths 404 (`:239`). |
| `/api/v1` safety survives a new Funnel scope | ✅ only if the Funnel stays **path-scoped** — `/api/v1` is "never public by construction" solely because Funnel forwards `/webhook` only (`api.ts:4-6`). ADR 0018 + stage 40 make "never Funnel the port" explicit and test edge 404s. |
| A transport can await `relay()` and own its reply | ✅ Reply routing is per transport: Webex awaits relay and sends `.text` (`server.ts:137,142`); app awaits and writes outbox (`app/server.ts:269-280`). `relay()` never throws (`server.ts:145`). |
| Hook needs a notice sink | ❌ not needed — `createNotifyFanout` (`fanout.ts:30`) is a fixed wrapper, no registry; hook is reply-only by design. |
| Reusable token compare | ⚠️ `tokenMatches` (SHA-256 + timingSafeEqual) is **duplicated privately** in `api.ts:70-78` and `app/server.ts:116-124`. Stage 39 extracts one shared helper (no behavior change). |
| Reusable HMAC | ⚠️ `verifySignature` (`server.ts:45-58`) is HMAC-**SHA1**, private, Webex-specific. Irrelevant for v1 (bearer); a future adapter should use SHA-256. |
| Durable dedup exists | ⚠️ `MessageDedup` is in-memory, Webex-only; app dedups via `app_outbox`. Hook gets its own durable `hook_messages` table — doubles as poll store. |
| Rate limiting exists | ❌ none anywhere in `src`. Stage 39 adds a small in-memory token bucket (no dependency). |
| Relay is serialized | ✅ single `enqueue` chain (`manager.ts:205-214`) for turns + rotations — sync waits can sit behind other turns; hence bounded wait + poll + pending cap. |
| Slow-turn ack reusable | ❌ Webex-only (`server.ts:121-141`); hook's 202 + poll replaces it. |
| Migrations | ✅ `migrations/0001…0010`, head 10; each file self-inserts `schema_version`. Next: `0011_hook_messages.sql`. |
| Reply files | ⚠️ `AssistantReply.files` are local paths — must never be returned publicly; v1 returns `filesOmitted` count only. |
| Live system health | ✅ 2026-10-16: daemon active, Claude auth valid, app transport + control API answering. (Separate issue: stored owner room 404s for proactive Webex notices — self-heals on next owner Webex message; not in scope.) |

## Contract safety

- **New seam ⇒ new contract** `contracts/hook-ingress.md` v1, frozen at
  creation. Additive: consumes `assistant-session` unchanged.
- `webex-ingress`, `app-ingress`, `control-api`: untouched; stage 39 must prove
  no behavior change (the `tokenMatches` extraction is the only shared edit).
- Architecture-affecting (second public surface) ⇒ ADR 0018, owner-confirmed.

## Split rationale

- **39 (feature, dark):** all code + tests + smoke asset; flag default off so it
  can merge and deploy with zero exposure.
- **40 (chore, ship):** provisioning a secret, a tailscaled Funnel mutation, and
  off-tailnet certification are operator acts on the live host — same split as
  stages 24–28 → 29 for the app transport.

## Known risks / open points (recorded, not blocking)

- **Token = owner password.** Owner-equivalent trust means a leaked token lets an
  internet caller drive the assistant (which can dispatch jobs on the host).
  Mitigations: dedicated token, 256-bit, rate limit, pending cap, independent
  rotation; documented in ARCHITECTURE. Accepted by owner.
- **Prompt injection via forwarded content.** v1 callers are owner-controlled;
  any future adapter that relays third-party payloads (GitHub, email) MUST frame
  them as data and gets its own assessment.
- **Funnel connection limits** for long synchronous waits are unverified;
  stage 40 step 6 measures and tunes `HOOK_MAX_WAIT_SEC`. Poll is the guarantee.
- **Shared queue contention:** hook turns delay owner Webex/app turns; the
  pending cap (3) and rate (6/min) bound it.
- **Doc drift noted, not fixed here:** `server.ts:5` and `docs/ARCHITECTURE.md`
  still say "cloudflared" for ingress (ADR 0006 moved to Funnel). Stage 39 touches
  ARCHITECTURE's transport section and may correct that line in passing.

## Out of scope (deferred)

- HMAC signing and per-service adapters (GitHub `X-Hub-Signature-256`, etc.).
- Outbound webhooks / callback URLs (push replies or notices to a caller URL).
- Attachments in, files out.
- Webex mirroring of hook exchanges.
