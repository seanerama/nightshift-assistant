# Contract: app-ingress

- **Status:** frozen v1
- **Owner:** transport module (`src/transport/app/`)
- **Normative spec:** `github:seanerama/agent-app-contract#v1.0.0` —
  `contracts/app-ingress.md` there is normative; `schemas/v1/*.json` win over
  prose. This file does NOT restate the wire spec; it binds this repo to that
  pin and freezes the repo-local choices. Certification is
  `npx agent-app-conformance <url> --token <t> --person-id <owner>` exiting 0.

## Exposes

All routes under `/app/v1/`, registered ONLY when `APP_TRANSPORT_ENABLED=true`
(flag off = routes absent), bound loopback + tailnet interface only (ADR 0011 —
never Funneled/cloudflared):

- `GET /app/v1/health`, `GET /app/v1/manifest` — manifest `capabilities` is
  **binding**: starts `["chat"]`; `files`, `mcp-tools`, `mcp-apps-ui` are added
  only when their stage's harness checks are green.
- `POST /app/v1/messages` — InboundMessage (schema-validated); returns **202
  before `relay()` runs**; dedup on client UUID (re-POST emits nothing new).
- `GET /app/v1/events` — SSE with `Last-Event-ID` resume and comment
  keep-alives. `GET /app/v1/outbox?after=` — poll fallback. Event id and
  `after` cursor are the SAME counter: `app_outbox.id` (ADR 0010).
- Event types: `ack` (session acceptance), `reply` (AssistantReply shape),
  `notice` (proactive sends).
- `POST /app/v1/uploads` (multipart → existing `uploads/<ts>-<name>` layout),
  `GET /app/v1/files/<id>` (serves `AssistantReply.files`).
- `POST /app/v1/mcp` — streamable-HTTP MCP (official TS SDK). Tools: `status`,
  `jobs_list`, `jobs_submit`, `jobs_kill`, `session_rotate` — thin doors over
  the same internals as the control API, no business logic (ADR 0012).
  Resource `ui://nightshift/jobs@v1` declaring
  `_meta["ui/tools"]: ["jobs_list", "jobs_kill", "jobs_submit"]` per
  `nightshift-client/contracts/ui-bridge.md` (convention lives in the client
  repo; the resource file header cites it).

## Consumes

- The frozen seam only: `InboundMessage → relay() → AssistantReply`
  (contracts/assistant-session.md) plus a second registered `send()` sink for
  proactive traffic. Webex transport, session manager, job runner, scheduler,
  watchdog: untouched.
- `App.jobs` / `App.sessions.rotate` for the MCP tools — the same doors
  contracts/control-api.md uses; shapes unchanged.
- Env: `APP_TRANSPORT_ENABLED` (default off), `NIGHTSHIFT_APP_TOKEN`
  (generated at deploy, host `.env`; distinct from `NIGHTSHIFT_API_TOKEN`),
  owner person id (existing config).
- SQLite (ADR 0004): table `app_outbox(id INTEGER PRIMARY KEY, type, payload,
  created_at, delivered_at NULL)` — outbox write is durable **before** any
  live emit. **No pruning** in v1: retention is unspecified upstream;
  a `TODO(contract-v1.0.1)` marker sits where pruning would go.

## Schema / wire

- Wire shapes are the pinned `schemas/v1/*.json` — this repo adds no fields.
- **Auth (fail closed, in order):** bearer `NIGHTSHIFT_APP_TOKEN` on EVERY
  route; **401 precedes 404** (surface not enumerable without a token); token
  unset → refuse all. `personId` != configured owner → 403 (vestigial but
  validated — do not remove).
- Ordering: `ack`/`reply`/`notice` are totally ordered by `app_outbox.id`; a
  client resuming from either the SSE `Last-Event-ID` or `?after=` sees the
  identical sequence (harness `cursor.equivalence`).

## Versioning

Frozen at **v1**, pinned to `agent-app-contract#v1.0.0`. Changes are
**additive only** — a breaking change (or a new upstream pin) is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this
shape.
