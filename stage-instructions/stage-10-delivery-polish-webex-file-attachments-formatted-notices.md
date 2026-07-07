# Stage 10: Delivery polish: Webex file attachments + formatted notices

- **Type:** feature
- **Depends on:** 5

## Objectives

Operator-requested (2026-07-07): artifacts must be deliverable to Webex and the
notices must stop being raw sentinel dumps. Exercise the attachment support the
frozen webex-ingress contract reserved ("send() accepts optional file
attachments"), add an on-request delivery action to the control surface, and
give every proactive notice a consistent, compact format.

## What to build

1. **Attachments in the transport** (`src/transport/webex.ts` + `send.ts`):
   `send(dest, markdown, files?)` — Webex multipart upload, ONE file per Webex
   message (API constraint): first chunk carries the first file, further files
   ride separate messages. Per-file size guard (Webex cap ~100MB → reject with a
   clear error above `NIGHTSHIFT_ATTACH_MAX_MB`, default 80). Send failures keep
   the existing never-silent fallback semantics.
2. **On-request delivery** (control surface, ADDITIVE to frozen control-api v1):
   `POST /api/v1/deliver` body `{ path: string, note?: string }` → sends the file
   to the owner's room; `nightshift deliver <path> [--note "..."]` CLI
   subcommand. Path must resolve inside an allow-listed root set
   (`$HOME/projects`, the app's `jobs/` + `logs/` dirs) — never arbitrary
   filesystem (the conversational session holds the API token; keep the blast
   radius bounded). Owner-room unknown → clear error telling the operator to
   message the bot first.
3. **Formatted notices** (`src/jobs/` notice builder + rotation notice):
   - Success: `✅ **<title>** — <type> finished` + a ≤2-sentence summary
     (truncate the sentinel summary at a sentence boundary) + an outputs line
     (paths) + a hint line (`say "send me <file>" for delivery`).
   - Failure (chain-terminal): `❌ **<title>** — failed after N attempts` +
     reason + log tail in a code fence (keep — genuinely useful).
   - Killed: `⏹ **<title>** — killed`.
   - Rotation: `🌀 Session rotated (<reason>) — summary at <path>`.
   One builder module with unit-tested output; app.ts uses it for onFinish and
   rotation notify.
4. **Auto-attach on success**: sentinel `outputs` entries that exist, are
   regular files, and are ≤ `NIGHTSHIFT_AUTOATTACH_MAX_MB` (default 10) ride the
   success notice (bounded count, e.g. first 3); larger artifacts (videos) stay
   on-request via deliver. Config both knobs in `.env.example`.
5. **Session preamble**: one line — deliver files with `nightshift deliver
   <path>`.

## Interface contracts

- **Consumes:** `webex-ingress.md` (attachments were reserved v1 — implementing,
  not changing); **additive** endpoint + subcommand on `control-api.md` v1
  (allowed: additive-only evolution). NO breaking edits; no migration.

## Testing requirements

- Chunker/send: multi-file send → file-per-message; oversize file rejected with
  the clear error; failure fallback preserved. Fixture Webex server accepts
  multipart and records filenames.
- Deliver: path inside allowed roots ok; traversal/outside path → 400; unknown
  owner room → clear error; CLI round-trip.
- Notice builder: golden-string tests for success/failure/killed/rotation
  variants incl. summary truncation at a sentence boundary and code-fenced log
  tail.
- Auto-attach: only existing ≤-limit files attach, bounded count; video-sized file
  skipped with the hint line present.
- **UI-smoke** (`docs/smoke/stage-10.md`): from Webex ask the assistant to send
  the lighthouse video (arrives as an attachment); complete a small job and
  confirm the formatted notice with auto-attached small outputs.

## Acceptance conditions

- [ ] Kill-switch: deliver endpoint + auto-attach dark unless control enabled (inherited) — attach knobs 0-disable
- [ ] UI-smoke authored (docs/smoke/stage-10.md)
- [ ] Additive migration only (none expected); additive-only contract evolution
- [ ] Existing suite stays green; CI all-green
- [ ] `.env.example` covers every new env read; no secrets in repo
- [ ] Deliver path confinement tested (no arbitrary filesystem reads)

## Pipeline test: NO
