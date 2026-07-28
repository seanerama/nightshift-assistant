# Stage 24: App transport walking skeleton: module, outbox migration, auth, manifest, CI harness gate

- **Type:** feature
- **Depends on:** none

> **Amendment 1 (2026-07-28, Intake/Planner re-scope):** the original split
> (skeleton-only here, chat triad in stage 25) is unsatisfiable against
> `agent-app-contract#v1.0.0`: `schemas/v1/manifest.json` requires
> `capabilities` to CONTAIN `"chat"` (`contains: {"const": "chat"}` — an empty
> list fails `manifest.ok`), and the conformance harness runs the chat-triad
> checks unconditionally ("the chat triad is core and gates nothing"). Exit 0 —
> the only definition of done (ADR 0009) — therefore requires the triad. This
> stage now ABSORBS former stage 25 (chat triad + send fan-out); stage 25 is
> superseded and its issue (#61) closed as folded into #60. Evidence: executor
> report 2026-07-28; mock passes 19 checks with 6 skips, all 9 chat checks in
> the passing set.

## Objectives

The thinnest slice of the app-ingress transport that the certifier will
actually certify: module + auth + manifest + outbox + the FULL chat triad
(202-fast messages, SSE resume, outbox poll, send fan-out), gated by a CI
conformance job that requires harness exit 0. Per the architect handoff
(docs/app-transport-design.md), the CI leg lands HERE, not at deploy time.

## What to build

### Skeleton

1. **Dev dependency:** `npm i -D github:seanerama/agent-app-contract#v1.0.0`
   (already pinned in the working tree by the executor's first pass). Commit
   the passing reference report from the mock run to
   `docs/smoke/stage-24-mock-report.txt` (already produced: exit 0, 19 passed,
   6 skipped — the skips are exactly the undeclared `files` / `mcp-tools` /
   `mcp-apps-ui` checks).
2. **Module `src/transport/app/`** owning its OWN `node:http` server (the
   daemon server binds `127.0.0.1` only — `src/transport/server.ts:4` — and
   must not be touched). Bind from `NIGHTSHIFT_APP_BIND` (comma-separated,
   default `127.0.0.1`; tailnet IP added at deploy, Stage 29). Port
   `NIGHTSHIFT_APP_PORT` (default 3778). Never `0.0.0.0`.
3. **Dark flag:** `APP_TRANSPORT_ENABLED` (default off) — flag off = listener
   never starts, routes absent. Flag on + `NIGHTSHIFT_APP_TOKEN` unset →
   refuse to start the app listener (fail closed, clear log), daemon otherwise
   healthy.
4. **Auth middleware:** bearer `NIGHTSHIFT_APP_TOKEN` on EVERY `/app/v1/`
   route; **401 precedes 404** (surface not enumerable — ADR 0011);
   constant-time compare, same discipline as the control API token check.
5. **Migration `migrations/0007_app_outbox.sql`:** `app_outbox(id INTEGER
   PRIMARY KEY, type TEXT, payload TEXT, created_at TEXT, delivered_at TEXT
   NULL)` per ADR 0010, additive, with the
   `-- TODO(contract-v1.0.1): pruning` marker (retention unspecified upstream).
6. **Routes:** `GET /app/v1/health`; `GET /app/v1/manifest` with capabilities
   exactly `["chat"]` — the schema-mandated floor, served for real by this
   stage; `files` / `mcp-tools` / `mcp-apps-ui` stay undeclared (harness skips
   them).

### Chat triad (absorbed from former stage 25)

7. **`POST /app/v1/messages`:** validate against the pinned `schemas/v1/`
   InboundMessage schema (invalid → 400, the harness's `messages.invalid.400`);
   `personId` != configured owner → 403 (vestigial but validated —
   `messages.notowner.403`); **202 BEFORE `relay()` runs** — enqueue and go,
   never hold the request for a Claude turn. Dedup on the client UUID, durable
   (table or unique index, not process memory — a restart must not turn a
   retry into a duplicate turn): re-POST → 202, nothing new emitted
   (`messages.dedup`).
8. **Outbox writer:** append-only `app_outbox` rows — `ack` (session
   acceptance), `reply` (the AssistantReply shape from `relay()`), `notice`
   (proactive). **Row committed BEFORE any live emit** (ADR 0010).
9. **`GET /app/v1/events`:** SSE; `id:` = `app_outbox.id`; `Last-Event-ID`
   resume replays rows `> id` from SQLite before going live; comment
   keep-alives on an interval.
10. **`GET /app/v1/outbox?after=<id>`:** poll fallback on the SAME counter
    (`cursor.equivalence`; invalid cursor handling per `outbox.cursor.invalid`).
11. **Send fan-out (the one structural change outside the module):** `sender`
    is today the single Webex `Sender` (`src/app.ts:84`) called directly at
    app.ts:119, 142, 151, 168 — no registry exists. Introduce a fan-out
    implementing the same `Sender` interface (`src/transport/send.ts:28`):
    always call the Webex sender exactly as before; flag on → also write a
    `notice` outbox row. Webex leg byte-identical (chunking, fallback,
    attachments live in the wrapped sender — nothing re-implemented). Flag off
    → passthrough.
12. **CI harness gate:** new job in `.github/workflows/ci.yml`: build, scratch
    DB, start the daemon with `APP_TRANSPORT_ENABLED=true` + generated token,
    run `agent-app-conformance <url> --token <t> --person-id <owner>`,
    **require exit 0**, kill. Standing gate for stages 26–28. If daemon boot
    hard-requires live Webex, isolate the app module's boot path enough to run
    it for CI WITHOUT changing existing behavior, and record the deviation in
    the PR.

**Deliberately NOT in this stage:** uploads/file serving (Stage 26), MCP
(Stage 27), UI resources (Stage 28), deploy (Stage 29), edits to
`src/transport/send.ts` internals, the session manager, the job runner, any
existing contract.

## Interface contracts

- **Exposes:** the certified chat surface (`/app/v1/` health, manifest,
  messages, events, outbox), the `app_outbox` table, the auth middleware, the
  fan-out `Sender`, and the CI conformance gate stages 26–28 hang off.
- **Consumes:** `contracts/app-ingress.md` v1 (frozen) pinned to
  `agent-app-contract#v1.0.0` (schemas win over prose);
  `contracts/assistant-session.md` v1 — `relay(InboundMessage) →
  AssistantReply` (`src/session/manager.ts:161`), consumed as-is;
  `contracts/webex-ingress.md` v1 — send() semantics MUST hold unchanged
  through the fan-out. `control-api`: untouched.

## Testing requirements

- Auth: no token → 401 on real AND fake paths; bad token → 401; good token +
  fake path → 404; flag off → connection refused; flag on + no token →
  fail-closed startup, daemon otherwise healthy.
- Migration: 0007 applies on a fresh DB and on a DB at 0006.
- Chat: durable-before-emit (fail the live emit in a double — row survives,
  resume delivers); dedup across a simulated restart; 202-before-relay (relay
  stub that never resolves — POST still returns); SSE resume from mid-stream
  `Last-Event-ID` replays exactly the missed rows; personId mismatch → 403.
- Fan-out: flag off → wrapped Webex sender receives byte-identical calls
  (golden assertion); flag on → one `notice` row per proactive send AND the
  Webex call unchanged. Existing Webex suite stays green untouched.
- CI conformance job green: harness exit 0, chat checks passing,
  `files`/`mcp-tools`/`mcp-apps-ui` reported skipped.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (n/a until Stage 29 — the committed mock report + CI harness stand in)
- [ ] Additive migration only (no destructive schema change)
- [ ] Passing mock reference report committed (`docs/smoke/stage-24-mock-report.txt`)
- [ ] 401-precedes-404 covered by test; capabilities exactly `["chat"]`, served
      for real
- [ ] Webex byte-identical: `src/transport/send.ts` undiffed; no behavior
      change at the four call sites with the flag off
- [ ] Existing suite stays green; CI all-green including the conformance job

## Pipeline test: NO
