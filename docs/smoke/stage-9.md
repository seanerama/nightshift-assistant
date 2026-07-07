# UI smoke — Stage 9 (workers survive daemon restarts)

Verifies `KillMode=process`: a `systemctl --user restart` must not kill running
workers; the startup reconciler re-adopts them and no retry attempt is consumed.

## Steps

1. Confirm the deployed user unit carries the directive (deploy.sh's sed must
   not strip it):

   ```sh
   grep KillMode ~/.config/systemd/user/nightshift-assistant.service   # KillMode=process
   ```

2. Submit a job that runs for a few minutes (any real pipeline job, or a
   generic job with a long task). Note its `pid` and `attempts` from
   `nightshift job <id>`.

3. `systemctl --user restart nightshift-assistant && sleep 5`

4. **Expect:** the worker pid still alive (`ps -p <pid>`); `nightshift job <id>`
   still `running` with the SAME attempts count; journal shows the reconciler
   leaving the live row alone (no "settling" line for it).

5. Let the job finish; confirm normal terminal state + notice.

## Failure triage

- Worker dead after restart → the unit in `~/.config/systemd/user/` lacks
  `KillMode=process` (re-run deploy; check deploy.sh's sed didn't drop it).
- Row flipped to failed/retry at restart → same cause; the reconciler settled a
  genuinely-dead pid. That is Stage 4 working correctly against the wrong unit.
