# UI smoke — Stage 4 (job runner)

Operator steps to verify the job runner observably works on the live host:
submit a trivial REAL job (worker = real `claude` writing a sentinel), watch it
run to `succeeded`, receive the Webex finish notice, and verify the per-job dir.
Then a kill check and a reconcile-after-daemon-restart check. Run after deploy,
with the Stage 1 smoke already passing.

## Prerequisites

- Stage 1 smoke passes (health check + round-trip ping).
- The job runner is enabled in the daemon's env file (it ships dark):

  ```sh
  # in the env file the service loads (e.g. ~/apps/nightshift-assistant/.env)
  NIGHTSHIFT_JOBS_ENABLED=true
  ```

  then restart the service and re-check `/health`.
- Send the bot any message from Webex first — finish notices go to the owner's
  last-seen room, which the DAEMON tracks in memory; a fresh restart has none
  until the first inbound message.

## 1. Submit a trivial real job (on-host one-liner)

`submit()` is not operator-exposed through Webex yet (capability wiring is a
later stage), so submit against the shared state directly. The one-liner
inserts the row and spawns the DETACHED worker, then exits; the DAEMON's
reconciler adopts the running row on its next 60s tick and settles it when the
worker finishes — which is exactly the reconciliation path this stage exists to
prove. Run from the app directory:

```sh
cd ~/apps/nightshift-assistant && set -a && . ./.env && set +a && \
mkdir -p /tmp/nightshift-smoke && \
node --input-type=module -e '
  const { createApp } = await import("./dist/app.js");
  const { loadConfig } = await import("./dist/config.js");
  const { createLogger } = await import("./dist/log.js");
  const app = createApp(loadConfig(), createLogger());
  const rec = app.jobs.submit({
    schema: 1, type: "smoke", title: "stage-4 smoke",
    instruction: "Create a file named hello.txt containing the word hello, then finish.",
    workdir: "/tmp/nightshift-smoke", env: "minimal",
  });
  console.log(JSON.stringify(rec, null, 2));
  process.exit(0);
'
```

**Expect:** a JSON `JobRecord` printed — `status: "running"`, a numeric `pid`,
a `sessionId`, and `logPath`/`sentinelPath` under `jobs/<id>/`. Note the `id`.

## 2. Watch it run to `succeeded` and receive the Webex notice

```sh
watch -n 5 'sqlite3 data/nightshift.db "SELECT id, status, attempts FROM jobs ORDER BY created_at DESC LIMIT 3"'
tail -f jobs/<id>/worker.log
```

**Expect:** within a couple of minutes (real claude session + the daemon's 60s
reconcile tick) the row flips `running → succeeded`, and the bot posts
`Job succeeded: "stage-4 smoke" …` with the worker's sentinel summary into your
Webex space. If the notice does not arrive, confirm you messaged the bot after
the last daemon restart (owner-room tracking is in-memory).

## 3. Verify the per-job dir and the minimal env

```sh
ls -l jobs/<id>/
cat jobs/<id>/sentinel.json
cat /tmp/nightshift-smoke/hello.txt
```

**Expect:** `instruction.txt`, `worker.log` (the worker's stdout/stderr), and
`sentinel.json` containing `{"schema":1,"status":"success","summary":…}`.
The sentinel — not the exit code — is what marked the job succeeded.

## 4. Kill check

Submit a long job (same one-liner, instruction: `"Run: sleep 300, then finish."`),
then kill it by id:

```sh
cd ~/apps/nightshift-assistant && set -a && . ./.env && set +a && \
node --input-type=module -e '
  const { createApp } = await import("./dist/app.js");
  const { loadConfig } = await import("./dist/config.js");
  const { createLogger } = await import("./dist/log.js");
  const app = createApp(loadConfig(), createLogger());
  console.log(JSON.stringify(app.jobs.kill("<id>"), null, 2));
  setTimeout(() => process.exit(0), (loadConfig().jobKillGraceSec + 2) * 1000);
'
```

**Expect:** the record prints `status: "killed"`; after the grace period the
pid is gone (`ps -p <pid>` empty — SIGTERM, then SIGKILL if it survived).
`attempts` stays 0 and no retry row appears (kill is terminal, not a failure).
The notice from this out-of-process run is skipped/logged (in-memory room
tracking lives in the daemon) — verify via sqlite instead.

## 5. Reconcile-after-daemon-restart check

Workers must survive a daemon restart and be re-adopted from their persisted pid:

```sh
# 1. submit a ~3 minute job (instruction: "Run: sleep 180, then finish.")
# 2. while it is running:
systemctl --user restart nightshift-assistant
ps -p <pid>          # worker STILL ALIVE — the daemon does not kill workers
sqlite3 data/nightshift.db "SELECT status FROM jobs WHERE id='<id>'"   # running
# 3. wait for the worker to finish, then within ~60s (reconcile tick):
sqlite3 data/nightshift.db "SELECT status FROM jobs WHERE id='<id>'"   # succeeded
```

**Expect:** the restarted daemon leaves the live worker alone (startup
reconcile: live pid → untouched), then settles the row from the sentinel on the
tick after the worker exits — and posts the finish notice, provided you have
messaged the bot since the restart.

## Failure triage

- One-liner throws `job runner is disabled` → `NIGHTSHIFT_JOBS_ENABLED=true`
  is missing from the env the shell loaded (step 0), or from the daemon's env
  for the reconciler/notice half.
- Row lands `failed` with `no completion sentinel was written` → the worker
  finished without writing the sentinel; read `jobs/<id>/worker.log`. The job
  auto-retries up to `NIGHTSHIFT_JOB_RETRY_CAP` (linked via `retry_of`), and
  only the final state notifies.
- No finish notice but the row is terminal → the daemon had not seen an owner
  room since its last restart (`job finish notice skipped` in journalctl), or
  the terminal transition happened in your one-liner process instead (e.g. you
  kept it alive past the worker's exit).
- Worker died at spawn (`worker spawn failed` in logs) → check
  `NIGHTSHIFT_AGENT_BIN`; remember the worker env is default-deny — `claude`
  must be reachable via `PATH` and authenticated via `HOME` (~/.claude) or
  `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`.
