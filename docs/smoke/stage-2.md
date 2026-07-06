# UI smoke — Stage 2 (rotation ritual)

Operator steps to verify rotation observably works on the live host: trigger a
rotation, confirm the daily log exists, and confirm the NEXT session boots with
seeded continuity. Run after deploy, with the Stage 1 smoke already passing.

## Prerequisites

- Stage 1 smoke passes (health check + round-trip ping).
- Rotation is enabled in the daemon's env file (it ships dark):

  ```sh
  # in the env file the service loads (e.g. ~/apps/nightshift-assistant/.env)
  NIGHTSHIFT_ROTATION_ENABLED=true
  ```

  then restart the service and re-check `/health`.

## 1. Establish context to carry across the boundary

From your Webex account, send the bot something memorable:

> Remember this for later: the bananas project launches Tuesday.

**Expect:** a normal reply.

## 2. Trigger a manual rotation (on-host one-liner)

`rotate()` is not operator-exposed through Webex yet (capability wiring is a
later stage), so trigger it against the daemon's state directly. Run this from
the app directory **while the assistant is idle** (no message mid-flight — the
one-liner is a separate process and does not share the daemon's turn queue):

```sh
cd ~/apps/nightshift-assistant && set -a && . ./.env && set +a && \
node --input-type=module -e '
  const { createApp } = await import("./dist/app.js");
  const { loadConfig } = await import("./dist/config.js");
  const { createLogger } = await import("./dist/log.js");
  const app = createApp(loadConfig(), createLogger());
  console.log(JSON.stringify(await app.sessions.rotate("manual"), null, 2));
  app.db.close();
'
```

**Expect:** a JSON `RotationRecord` printed — `closedSessionId`, `newSessionId`,
`reason: "manual"`, `summaryPath`, `transcriptPath`, `rotatedAt`. A logged
`rotation notice skipped: no owner room seen yet` line is normal for this
out-of-process run (the in-memory room tracking lives in the daemon).

**Alternative (fully in-band, exercises the notice too):** temporarily set
`NIGHTSHIFT_SIZE_CAP_TURNS=1` in the env file, restart, and send two messages —
the second turn's completion triggers a size-cap rotation and the bot posts
"Rotated the conversational session (size-cap); summary at logs/daily/….md"
into your space. Restore the cap and restart afterwards.

## 3. Verify the daily log on the host

```sh
ls -l ~/apps/nightshift-assistant/logs/daily/$(date +%F)*.md
cat ~/apps/nightshift-assistant/logs/daily/$(date +%F)*.md
```

**Expect:** at least one summary file for today containing what was
discussed/decided/built/unfinished, and (usually) a `=== DURABLE MEMORY ===`
block. If durable facts were emitted, `memory/MEMORY.md` and a dated
`memory/YYYY-MM-DD.md` exist too.

## 4. Verify seeded continuity across the boundary

From Webex, send:

> What did I tell you about the bananas project?

**Expect:** a reply that references the Tuesday launch **within 60 seconds**,
even though this is a brand-new session (the daily summary + memory seed was
appended to the system prompt). Confirm it really was a new session:

```sh
journalctl --user -u nightshift-assistant -n 100 --no-pager | grep -E 'session rotated|conversational session'
```

The reply's session id (in `sqlite3 data/nightshift.db "SELECT session_id FROM
sessions WHERE is_current=1"`) must differ from `closedSessionId` in step 2.

## Failure triage

- One-liner refuses to start → the env file lacks `NIGHTSHIFT_ENABLED=true` or
  a required Webex var (config fails fast by design).
- `rotate: no current conversational session` → no session exists yet; send the
  bot a message first (step 1).
- Summary file says `Summary turn FAILED during rotation` → the outgoing
  session could not produce a summary (rotation still completed, by design);
  check `journalctl` for `rotation summary turn failed`.
- Reply in step 4 shows no continuity → check the daemon logs for the seeded
  invocation; confirm `NIGHTSHIFT_ROTATION_ENABLED=true` was set in the env the
  DAEMON runs under (not just your shell), and that `logs/daily/` + `memory/`
  are non-empty.
