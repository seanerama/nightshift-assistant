# UI smoke — Stage 10 (Webex file attachments + formatted notices)

Verifies the two operator-visible halves of delivery polish on the live daemon:
on-request file delivery (attachment arrives in Webex) and the formatted
finish notice with small outputs auto-attached.

Prereqs: `NIGHTSHIFT_CONTROL_ENABLED=true`, `NIGHTSHIFT_JOBS_ENABLED=true`,
and you have messaged the bot at least once (the owner room is persisted, so
any past message — even before the last restart — counts).

## 1. On-request delivery (the lighthouse video)

1. In Webex, ask the assistant to send the lighthouse video, e.g.
   *"send me the lighthouse story video"*.
2. **Expect:** the session runs `nightshift deliver <path>` and the video
   arrives in the Webex conversation **as a file attachment** (not a path, not
   a link), optionally with a `📎 <filename>` message.
3. Spot-check confinement from SSH (both must fail cleanly):

   ```sh
   nightshift deliver /etc/passwd          # error: outside the deliverable roots
   nightshift deliver ~/projects           # error: not a regular file
   ```

## 2. Formatted finish notice + auto-attach

1. Submit a small job that produces a small artifact, e.g. from Webex:
   *"write a 100-word haiku collection to haiku.txt in ~/projects/scratch"*
   (or over SSH: `nightshift submit --type generic --title "haiku" ...`).
2. Let it finish. **Expect** the notice in Webex:
   - `✅ **<title>** — <type> finished` (bold title, no raw sentinel JSON);
   - a summary of AT MOST two sentences;
   - an `Outputs: <paths>` line and the hint
     `Say "send me <file>" for delivery.`;
   - the small output file **attached to the notice** (≤ 10MB default cap,
     first 3 outputs at most).
3. Kill a sleeper job (`nightshift kill <id>`) → `⏹ **<title>** — <type> killed`.
4. Rotate (`nightshift rotate`) → `🌀 Session rotated (manual) — summary at <path>`.

## Failure triage

- Delivery says "no owner room is known yet" → message the bot once, retry
  (if it recurs after a restart, the settings table isn't persisting —
  check migration 0005 applied: `sqlite3 data/nightshift.db 'SELECT * FROM schema_version'`).
- Attachment rejected "over the …MB cap" → raise `NIGHTSHIFT_ATTACH_MAX_MB`
  (Webex's hard cap is ~100MB — stay under it).
- Notice arrives without the small file → check `NIGHTSHIFT_AUTOATTACH_MAX_MB`
  (0 disables) and that the control surface is enabled; the hint line + on-request
  deliver still work either way.
- Raw `Job succeeded: ...` text → the daemon is running a pre-Stage-10 build.
