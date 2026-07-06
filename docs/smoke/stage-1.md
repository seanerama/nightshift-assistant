# UI smoke — Stage 1 (walking skeleton)

Operator steps to verify the deployed spine observably works. Run after deploy,
on the dev server, with the daemon under systemd and the cloudflared route live.

## Prerequisites

- The NEW parallel-run Webex bot identity exists (not the old NSAF bot), its
  webhook is registered with the shared secret, and `/etc/nightshift/nightshift.env`
  carries `WEBEX_BOT_TOKEN`, `WEBEX_WEBHOOK_SECRET`, `WEBEX_OWNER_PERSON_ID`,
  and `NIGHTSHIFT_ENABLED=true` (the kill-switch stays `false` until you flip it).
- `systemctl status nightshift-assistant` shows active (running).

## 1. Health check (on-host)

```sh
curl -s http://127.0.0.1:3777/health
```

**Expect:** HTTP 200 with `{"ok":true,"version":"<x.y.z>","uptimeSec":<n>}`.
(Adjust the port if `NIGHTSHIFT_PORT` is set.)

## 2. Round-trip ping (from Webex)

1. From your own Webex account (the owner identity), open the 1:1 space with
   the new bot.
2. Send: `ping`
3. **Expect:** a session-generated reply within **60 seconds**. Any coherent
   assistant reply counts; an error message counts as a failure; silence counts
   as a failure.

## 3. Verify it was the real spine (on-host, optional)

```sh
journalctl -u nightshift-assistant -n 50 --no-pager | grep -E 'relaying inbound|reply delivered'
```

**Expect:** a `relaying inbound message` line followed by `reply delivered`
for the ping's messageId.

## Failure triage

- 401s in the journal → webhook secret mismatch between Webex and the env file.
- `webhook dropped: sender is not the owner` → `WEBEX_OWNER_PERSON_ID` is wrong
  (it must be YOUR personId, not the bot's).
- `startup refused` at boot → kill-switch off or a required env var missing.
- Reply is the "assistant session hit an error" message → check that the
  `claude` binary is on PATH for the service user (or set `NIGHTSHIFT_AGENT_BIN`).
