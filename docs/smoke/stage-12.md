# UI smoke — Stage 12 (explicit models, CLI-spelling allowances, dispatch honesty)

Verifies the three operator-approved fixes from issue #22 on the live daemon:
the conversational session runs on an explicit `--model` (default
`claude-sonnet-5`), dispatched workers run on their type's registry model
(Opus for the pipelines), and the session's own CLI is allowed in every
spelling it reaches for — with the honesty rule keeping dispatch claims tied
to real job ids.

Prereqs on the host `.env`: `NIGHTSHIFT_CONTROL_ENABLED=true`,
`NIGHTSHIFT_JOBS_ENABLED=true`, `NIGHTSHIFT_TYPES_ENABLED=true`. Leave
`NIGHTSHIFT_MODEL` unset for step 1 (the default is under test). Restart the
daemon after pulling this stage so a FRESH conversational session picks up the
new preamble (or `nightshift rotate` once).

## 1. Conversational spawn carries --model (default sonnet)

1. In Webex: send any message (e.g. *"hello"*).
2. While the turn is in flight (or immediately after, for the next turn), over
   SSH:

```sh
ps -eo pid,args | grep -E 'claude .*--output-format json' | grep -v grep
```

3. **Expect:** the conversational `claude` process argv contains
   `--model claude-sonnet-5` — regardless of any host-level claude config.
   (The kill-switches do NOT gate this: it is runtime config, present even
   with control disabled.)
4. Optional override check: set `NIGHTSHIFT_MODEL=claude-opus-4-8` in `.env`,
   restart, send a message, re-run the `ps` — argv now shows
   `--model claude-opus-4-8`. Revert and restart before continuing.

## 2. Worker spawn carries the type's model

1. In Webex: *"make me a short story about a lighthouse mouse"* (or submit
   directly: `nightshift submit --type story --params '{"idea":"a lighthouse
   mouse"}'`).
2. Over SSH while the worker runs:

```sh
ps -eo pid,args | grep -E 'claude -p' | grep -v grep
```

3. **Expect:** the worker argv contains `--model claude-opus-4-8` (story is a
   pipeline type), with `--model` BEFORE `--permission-mode`/`--allowedTools`.
4. Generic check: `nightshift submit --type generic --params
   '{"instruction":"sleep 30 && echo done; write the sentinel","workdir":"~/projects/scratch"}'`
   → the worker argv shows `--model claude-sonnet-5`.
5. Kill any smoke jobs you don't want to finish: `nightshift kill <id>`.

## 3. Path-prefixed CLI spellings now succeed

The 2026-07-07 live failure: the session invoked `bin/nightshift` and was
denied. All three spellings are now allowed at spawn.

1. In Webex: *"run exactly `bin/nightshift status` through your Bash tool and
   paste the raw output"*.
2. **Expect:** the command executes (no permission denial) and the reply shows
   real daemon status output.
3. Repeat with *"now exactly `./bin/nightshift status`"* and with bare
   *"`nightshift status`"*. **Expect:** all three succeed.

## 4. Dispatch honesty

1. In Webex: *"dispatch a study job on BGP fundamentals"*.
2. **Expect:** the reply QUOTES the job id the CLI returned (compare against
   `nightshift jobs` over SSH — the id must exist). No "I've submitted it"
   without an id.
3. Negative case: temporarily set `NIGHTSHIFT_JOBS_ENABLED=false`, restart,
   rotate (fresh preamble), then ask for a dispatch again. **Expect:** the
   session reports plainly that the submit was refused/denied and STOPS — it
   must not claim the job was dispatched or invent an id. Revert the flag and
   restart.

## Failure triage

- `ps` shows no `--model` on the conversational spawn → the daemon is running
  pre-Stage-12 code; check the deployed commit and restart.
- Step 3 denied → the session predates the new `--allowedTools` value; every
  spawn carries the rule, so a plain restart (or one more message after
  restart) is enough — the rule is per-spawn, not per-session.
- Step 4 invents a job id → the session predates the new preamble (it is only
  delivered to NEW sessions); `nightshift rotate` and retry.
- Worker model wrong → check `jobs/<id>/job-type.txt` exists for typed rows
  (missing marker ⇒ generic spawn shape, sonnet model by design).
