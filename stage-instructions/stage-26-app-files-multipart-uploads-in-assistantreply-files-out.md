# Stage 26: App files: multipart uploads in, AssistantReply files out

- **Type:** feature
- **Depends on:** 24

> **Dependency amended 2026-07-28:** originally depended on stage 25, which was
> superseded and folded into stage 24 (see Amendment 1 in the stage-24 spec).

## Objectives

Attachments flow both ways through the app door with the same meaning they have
on the Webex side: an upload from the phone lands in the layout the session
already understands, and a reply's files are retrievable by the client. The
`files` capability is declared only when BOTH directions work.

## What to build

1. **`POST /app/v1/uploads`:** multipart, written to the EXISTING
   `uploads/<ts>-<name>` layout (`src/types.ts:16` — this is what
   `InboundMessage.attachments` paths mean to the session; reuse the Webex
   attachment-download naming helper rather than inventing a sibling scheme).
   Response per the pinned schema (upload id the client then references in an
   InboundMessage's attachments). Enforce the existing size cap discipline
   (`NIGHTSHIFT_ATTACH_MAX_MB` precedent, `src/transport/send.ts:43`) — reject
   oversize BEFORE writing.
2. **`GET /app/v1/files/<id>`:** serves the files named by
   `AssistantReply.files`. **This must not be an arbitrary-path read.** Map ids
   to concrete paths (issued when a reply/notice referencing files is written
   to the outbox, or an equivalent durable mapping) and confine resolution the
   way delivery already does — the deliverer's confined roots are `~/projects`
   + the app's `jobs/` and `logs/` (`src/app.ts:183-184`), plus `uploads/`.
   A request for an id outside the mapping → 404 (after auth; 401 still
   precedes it).
3. **Wire-through:** an InboundMessage that references uploaded attachments
   reaches `relay()` with absolute paths exactly as the Webex transport
   produces them — the session must not be able to tell which door a file came
   through.
4. **Manifest:** add `"files"` only when upload→attach→retrieve all pass.

**Deliberately NOT in this stage:** MCP, UI resources, changes to the
deliverer, chunker, or Webex attachment behavior, retention/cleanup of uploads
(same no-pruning posture as the outbox — TODO(contract-v1.0.1)).

## Interface contracts

- **Exposes:** `/app/v1/uploads`, `/app/v1/files/<id>`; upload ids usable in
  InboundMessage attachments.
- **Consumes:** `contracts/app-ingress.md` v1 + pinned schemas;
  `contracts/assistant-session.md` v1 (attachment path semantics of
  InboundMessage / AssistantReply, unchanged); the existing uploads layout.

## Testing requirements

- Round-trip unit/integration: multipart upload → file exists under
  `uploads/<ts>-<name>` → InboundMessage referencing it reaches a relay stub
  with the absolute path → a reply naming a file under a confined root is
  retrievable via `/files/<id>` byte-identical.
- Security: path traversal in the multipart filename is neutralized (name
  sanitization, no `..` escape from uploads/); `/files/<id>` refuses ids not in
  the mapping; a reply file outside the confined roots is not served.
- Oversize upload rejected before any bytes land.
- CI conformance job passes the harness upload→attach→retrieve round-trip.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) still gates everything
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (n/a until Stage 29)
- [ ] Additive migration only (no destructive schema change)
- [ ] `"files"` declared only with both directions harness-green
- [ ] No arbitrary-path read: traversal + confinement tests present and green
- [ ] Existing suite stays green; CI all-green including conformance

## Pipeline test: NO
