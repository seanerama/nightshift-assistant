# Stage 20: note-ingest job type: worker interprets a reMarkable note, delivers to Webex and/or tablet

- **Type:** feature
- **Depends on:** none (additive job type; consumes the cross-repo `note-submission` contract)

## Objectives

Close the **INBOX** loop: a new declarative **`note-ingest`** job type. The reMarkable watcher
(separate repo, remarkable-bridge) shells `nightshift submit --type note-ingest --params '<json>'`
when the user drops a note in the tablet's `/Outbound`. The spawned worker reads the note
(typed text + rendered handwriting page images), interprets it, and **delivers by content**:
reply in the owner's Webex room and/or push a document to the tablet's `/NS-Inbox` — the note
decides. Additive on `job-lifecycle` v1 (a new registry entry is the sanctioned pattern,
Stages 6/16 precedent). Inert until submitted (no watcher yet → no production change).

## What to build

Add ONE declarative entry to the `registry` in **`src/jobs/types.ts`**, mirroring an existing
type (e.g. the guide/pipeline type). No new endpoint, no wiring beyond the table.

- **`type`**: `note-ingest`.
- **`validateParams`**: require `note_id`, `doc_name`, `source_folder` (non-empty strings);
  accept `text` (string, may be `""`) and `images_dir` (string, may be `""`). This must match
  the frozen **`note-submission`** contract (see remarkable-bridge `contracts/note-submission.md`):
  keys `{ note_id, doc_name, source_folder, text, images_dir }`.
- **`workdirStrategy`**: if `images_dir` is a non-empty existing path, use it as the worker's
  workdir (so the CLI's workdir-scoped file tools can read the ordered `page-NN.png` renders and
  the worker can write a result file there); else a scratch workdir under the app `jobs/` dir
  (house default). Confirm against `runner.ts` how workdir + cwd are applied.
- **`instructionTemplate`**: tell the worker it is processing a note the user wrote on their
  reMarkable and dropped in `{source_folder}`. Include `{text}` when present; when `images_dir`
  is set, instruct it to READ the `page-NN.png` images in its workdir as the handwritten note.
  Then: *interpret the note and act on it. Choose delivery by what the note asks —*
  - *reply in Webex:* `nightshift deliver <message>` (owner room),
  - *send a document to the tablet /NS-Inbox:* write your result as markdown to a file in the
    workdir, then `remarkable-bridge push --md <file> --title "<name>"`,
  - *do both when warranted; if you can't complete it, say so in Webex.* Report what you did.
- **`permissionArgs`**: least-privilege allowlist — the worker needs `Read Grep Glob` (read the
  note/images), `Write` (compose a result file), and the two delivery CLIs:
  `Bash(nightshift deliver *)` and `Bash(remarkable-bridge push *)`. NOTHING broader (no arbitrary
  Bash). Mirror the exact permission-flag shape existing types use.
- **`extraEnv`**: add only what the worker needs to invoke the delivery CLIs from the default-deny
  worker env (`src/jobs/env.ts`) — e.g. `RMAPI_BIN` and PATH reachability for `remarkable-bridge`
  + `rmapi`. Names must not use a hard-blocked prefix. If the tablet-push path needs env plumbing
  that isn't cleanly expressible, ship **Webex delivery working** and gate the tablet-push line of
  the instruction clearly (document the exact env addition needed) rather than half-wiring it.
- **`model`**: a capable model consistent with the other reasoning workers (e.g. the pipeline
  type's model).
- **`titleTemplate`**: e.g. `note: {doc_name}`.

## Interface contracts

- **Consumes (frozen):** `job-lifecycle` v1 (registry entry + worker spawn + completion notice to
  Webex — reused for free), and the cross-repo **`note-submission`** v1 param shape. **No new
  contract; no frozen contract reopened.**
- **Exposes:** the `note-ingest` job type.

## Testing requirements

- Unit (vitest, no real worker/CLIs): `validateParams` accepts a valid `note-submission` params
  object and rejects missing `note_id`/`doc_name`/`source_folder`; `instructionTemplate` includes
  the text and the image-reading instruction when `images_dir` is set, and the two delivery
  options; `permissionArgs` is exactly the least-privilege set (assert no arbitrary `Bash`);
  `workdirStrategy` returns `images_dir` when present else a scratch dir; `titleTemplate` shape.
- No real `claude`, `nightshift deliver`, `remarkable-bridge`, tablet, or cloud in tests.
- UI-smoke (operator, post full deploy): submit `nightshift submit --type note-ingest --params
  '{...}'` with a sample note → worker runs → a Webex reply arrives (and, if wired, a tablet doc).

## Acceptance conditions

- [ ] `note-ingest` registered; `validateParams` matches the frozen `note-submission` shape.
- [ ] Least-privilege `permissionArgs` (Read/Grep/Glob/Write + `nightshift deliver` + `remarkable-bridge push` only; no arbitrary Bash) — asserted.
- [ ] Webex delivery works; tablet-push either wired or cleanly gated with the documented env need.
- [ ] Additive only — job-lifecycle behavior unchanged; no frozen contract reopened; no schema change.
- [ ] Existing suite stays green; CI all-green.

## Pipeline test: YES
