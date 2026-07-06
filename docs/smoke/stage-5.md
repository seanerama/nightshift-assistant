# UI smoke — Stage 5 (control API + nightshift CLI)

Operator steps to verify the assistant's hands observably work on the live
host: ask for system status from Webex (the session must run the REAL
`nightshift status` and quote it), have it submit a REAL job from chat, watch
the finish notice arrive on its own, then confirm the same truth by hand over
SSH with the same CLI. Run after deploy, with the Stage 1 and Stage 4 smokes
already passing.

## Prerequisites

- Stage 1 smoke passes (health check + round-trip ping); Stage 4 smoke passed.
- The control surface is enabled and the token exists (it ships dark):

  ```sh
  # in the env file the service loads (e.g. ~/apps/nightshift-assistant/.env)
  NIGHTSHIFT_JOBS_ENABLED=true
  NIGHTSHIFT_CONTROL_ENABLED=true
  NIGHTSHIFT_API_TOKEN=<openssl rand -hex 32>
  ```

  then restart the service. Startup FAILS FAST if the flag is on with no
  token — check `journalctl --user -u nightshift-assistant` if it won't start.
- The deploy symlinked the CLI (deploy.sh does this): `which nightshift`
  → `~/.local/bin/nightshift`. Make sure `~/.local/bin` is on the PATH the
  daemon inherits (the session's Bash finds `nightshift` through the daemon's
  own environment).
- IMPORTANT: the session only learns about its new tool at session START
  (the capability preamble rides the new-session system prompt). After
  flipping the flag, rotate once so the next message starts a fresh session:

  ```sh
  cd ~/apps/nightshift-assistant && nightshift rotate
  ```

## 0. CLI sanity by hand (SSH)

```sh
nightshift status
nightshift status --json
```

**Expect:** a readable block — version, uptime, session id + turns, job
counts, rotation/job-runner flags; `--json` prints the raw
`{ "ok": true, ... }` envelope. Exit code 0 (`echo $?`).

Gate checks:

```sh
NIGHTSHIFT_API_TOKEN=wrong nightshift status; echo $?   # error: unauthorized, exit 1
```

## 1. "What's the system status?" from Webex

Send the bot: **"What's the system status? Use your nightshift CLI and quote
its output."**

**Expect:** a reply quoting real `nightshift status` output — the version and
uptime must match what you saw over SSH in step 0 (same daemon, same truth).
If the session claims it has no such tool, you skipped the rotate in the
prerequisites (old session, no preamble) — rotate and retry.

## 2. Submit a job from chat

Send: **"Submit a job that writes the word hello into a file in
/tmp/nightshift-smoke and tell me its id."**

**Expect:** a prompt reply containing a job id (the session ran
`nightshift submit ...` and read the id from the output — long work was
dispatched, not run inline). The reply should arrive in seconds; the job runs
in the background.

## 3. Watch the finish notice arrive on its own

Do nothing.

**Expect:** within a couple of minutes the bot posts
`Job succeeded: ... ` with the worker's sentinel summary — unprompted (the
daemon's finish notice, not the session). Then:

```sh
cat /tmp/nightshift-smoke/hello*
```

shows the file the worker wrote.

## 4. Confirm the same truth by hand (SSH)

```sh
nightshift jobs
nightshift job <id-from-step-2>
```

**Expect:** the job from step 2 in the list with `succeeded`, and the detail
view showing the same workdir/log paths the notice referenced. The operator
CLI and the assistant's tool are one surface — what the bot told you and what
the CLI prints must agree.

## 5. Kill-switch check (control goes dark)

```sh
sed -i 's/^NIGHTSHIFT_CONTROL_ENABLED=true/NIGHTSHIFT_CONTROL_ENABLED=false/' .env
systemctl --user restart nightshift-assistant
nightshift status; echo $?    # error: control surface is disabled..., exit 1
```

**Expect:** every CLI/API call refuses (403 under the hood); chat still works
(the webhook path is untouched) but the session no longer gets the tool rule.
Flip back to `true` and restart when done; rotate again to restore the
session's tool awareness.

## Failure triage

- `nightshift: command not found` → the deploy symlink is missing
  (`ln -sfn ~/apps/nightshift-assistant/bin/nightshift ~/.local/bin/nightshift`)
  or `~/.local/bin` is not on PATH.
- `error: NIGHTSHIFT_API_TOKEN is not set` → the token is neither exported nor
  in the app dir's `.env`; the CLI resolves `.env` relative to the script's
  REAL path (symlink-safe), so a copied — not symlinked — binary looks in the
  wrong place.
- `error: unauthorized` from your own shell → shell env carries a stale
  `NIGHTSHIFT_API_TOKEN` overriding the `.env` value.
- The session replies "I don't have that capability" → it predates the flag
  flip; `nightshift rotate` and message again.
- Step 2's reply names a job but `nightshift jobs` doesn't show it → the
  session hallucinated instead of running the CLI; check
  `journalctl --user -u nightshift-assistant` for the API request log lines
  around that time.
