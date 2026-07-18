# UI smoke — Stage 16 (tech-guide job type)

Verifies the `guide` registry type end-to-end on the live daemon: a typed submit
dispatches the /tg Techguide pipeline as a background job and produces the guide
artifact. Run on the prod host with `NIGHTSHIFT_TYPES_ENABLED=true`.

## Steps

1. Host prerequisites (the Stage 6 skill seam — one-time check):

   ```sh
   ls ~/.claude/commands/tg/start.md ~/.claude/tg/bin/sws-tools.cjs   # both exist
   ```

2. Submit a deliberately small topic; quote the returned job id:

   ```sh
   nightshift submit --type guide --params '{"topic": "git bisect basics", "variant": "explainer"}'
   nightshift job <id>   # type=guide, title 'Guide: git bisect basics (explainer)', workdir ~/projects/git-bisect-basics
   ```

3. **Expect while running:** `jobs/<id>/job-type.txt` contains `guide`; the worker
   argv (`ps -fp <pid>`) carries `--model claude-opus-4-8`, `--permission-mode
   acceptEdits`, and the pipeline allowedTools — never `bypassPermissions`.

4. **Expect on finish:** job reaches `succeeded`, the ✅ Webex notice arrives, and
   the artifact exists:

   ```sh
   ls ~/projects/git-bisect-basics/output/*/guide/   # populated HTML
   ```

5. Preamble check (after the next session rotation): ask the bot what job types it
   can dispatch — the reply must include `guide` with the variant params.

## Failure triage

- `unknown job type: guide` → deployed build predates stage 16 (redeploy) or
  `NIGHTSHIFT_TYPES_ENABLED` is off.
- Worker denials on `node .../tg/bin/sws-tools.cjs` in `jobs/<id>/worker.log` →
  the spawn missed the pipeline permission args: check `job-type.txt` exists
  (raw `--instruction` submits spawn near-zero by design — use `--type guide`).
- Pipeline stalls asking questions → AUTONOMY_NOTE missing from the instruction
  (inspect `jobs/<id>/instruction.txt`).
- `output/<slug>/guide/` empty on success → the sentinel lied; treat as a
  dispatch-honesty bug and pull the worker transcript.
