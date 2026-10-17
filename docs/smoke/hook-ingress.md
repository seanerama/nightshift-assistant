# UI smoke — hook ingress (Stage 39 code, executed live in Stage 40)

Verifies the public chat-only door end to end, **from OFF the tailnet**:
`POST /hook/v1/messages` with `NIGHTSHIFT_HOOK_TOKEN` returns the assistant's
reply synchronously (or a poll handle), the surface refuses everything without
the token, re-POSTs are idempotent, the rate limit bites, and — the security
half — the Funnel exposes `/hook/v1` and `/webhook` ONLY: `/api/v1/*`,
`/app/v1/*` and `/health` must all 404 at the Funnel edge. Contract:
`contracts/hook-ingress.md` v1; design: ADR 0018.

Prereqs on the prod host (`.env`, restart after editing):
`HOOK_INGRESS_ENABLED=true` and `NIGHTSHIFT_HOOK_TOKEN` set (generated —
`openssl rand -hex 32` — distinct from the API and app tokens; never paste it
into chat, tickets, or shell history you keep). The Funnel carries the extra
path scope:

```sh
sudo tailscale funnel --bg --set-path /hook/v1 http://127.0.0.1:3777/hook/v1
tailscale funnel status   # expect exactly: /webhook, /hook/v1 (+ the unrelated /csweet/webhook)
```

Run every `curl` below from a machine that is **not on the tailnet** (phone
hotspot, a cloud shell) so the request really crosses the Funnel edge. Set:

```sh
BASE=https://<host>.<tailnet>.ts.net          # the Funnel hostname
read -rs HOOK_TOKEN                           # paste the token; not echoed, not in history
```

## 0. Flag-off absence check (run FIRST, before enabling the flag)

With `HOOK_INGRESS_ENABLED` unset/false and the `/hook/v1` scope already added:

```sh
curl -sS -w '\n%{http_code}\n' -H "Authorization: Bearer $HOOK_TOKEN" \
  -H 'content-type: application/json' -d '{"text":"ping"}' "$BASE/hook/v1/messages"
```

**Expect:** `404` with body `{"error":"not found"}` — identical to any unknown
path on the daemon. Anything else with the flag off is a breach — stop. Then
enable the flag and restart (`sudo systemctl restart nightshift`); the journal
must show no `hook ingress refusing all requests` error (that line means the
token is unset).

## 1. 401 without (or with a wrong) token — on every path

```sh
for p in /hook/v1/messages /hook/v1/messages/anything /hook/v1/nope /hook/v1; do
  curl -sS -o /dev/null -w "$p %{http_code}\n" -X POST "$BASE$p"
  curl -sS -o /dev/null -w "$p wrong %{http_code}\n" -H 'Authorization: Bearer wrong' "$BASE$p"
done
```

**Expect:** every line `401`; a body (if shown) of
`{"ok":false,"error":"unauthorized"}`. A `404`/`405` here means routing runs
before auth — the surface is enumerable — stop.

## 2. 200 synchronous reply

```sh
curl -sS -w '\n%{http_code}\n' -H "Authorization: Bearer $HOOK_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"Reply with exactly the word: hook-smoke-ok","source":"smoke","messageId":"smoke-sync-1"}' \
  "$BASE/hook/v1/messages"
```

**Expect:** `200` with
`{"ok":true,"status":"completed","messageId":"smoke-sync-1","reply":{"text":"…hook-smoke-ok…","rotated":false,"filesOmitted":0}}`.
Note the wall time — if a normal turn regularly exceeds the Funnel's
connection tolerance, lower `HOOK_MAX_WAIT_SEC` (poll is the guarantee).

## 3. 202 + poll on `wait:0`

```sh
curl -sS -w '\n%{http_code}\n' -H "Authorization: Bearer $HOOK_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"What is 2+2? One word.","source":"smoke","messageId":"smoke-poll-1","wait":0}' \
  "$BASE/hook/v1/messages"
# then, every few seconds until status is no longer "pending":
curl -sS -H "Authorization: Bearer $HOOK_TOKEN" "$BASE/hook/v1/messages/smoke-poll-1"
```

**Expect:** the POST answers immediately with `202`
`{"ok":true,"status":"pending","messageId":"smoke-poll-1","poll":"/hook/v1/messages/smoke-poll-1"}`;
the GET first shows `"status":"pending"` (HTTP 200), then
`"status":"completed"` with `reply.text`. An unknown id
(`$BASE/hook/v1/messages/never-sent`) answers `404`
`{"ok":false,"error":"not found"}` — only with the token.

## 4. Idempotent re-POST

Repeat the exact step-2 command (same `messageId: smoke-sync-1`).

**Expect:** `200` with the **same** body as step 2, returned immediately, and
no new turn — the journal shows `hook re-POST answered from state` for
`smoke-sync-1` and no new `hook turn settled` line for it.

## 5. 429 after the burst

The POST bucket holds 3 (refill `HOOK_RATE_PER_MIN`, default 6/min). Wait
~30s after step 4 so the bucket is full, then:

```sh
for i in 1 2 3 4; do
  curl -sS -o /dev/null -D - -H "Authorization: Bearer $HOOK_TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"text\":\"burst $i, reply ok\",\"source\":\"smoke\",\"wait\":0}" \
    "$BASE/hook/v1/messages" | grep -Ei '^(HTTP|retry-after)'
done
```

**Expect:** three `202`s, then `429` with a `Retry-After:` header (seconds).
(A `429` body of `too many pending hook turns` before the 4th also proves the
pending cap; either 429 passes.) Unauthenticated floods never consume the
bucket — step 1 run just before step 5 must not cause an early 429.

## 6. The Funnel exposes nothing else

```sh
for p in /api/v1/status /app/v1/health /health; do
  curl -sS -o /dev/null -w "$p %{http_code}\n" "$BASE$p"
done
```

**Expect:** all three `404` at the Funnel edge (Funnel has no matching path
scope). A `200`/`401`/`403` on any of them means the port or a wrong scope is
Funneled — **revert the Funnel change immediately** and stop.

## 7. Webex still round-trips

Send one ordinary message to the bot in the Webex room.

**Expect:** a normal reply in Webex. The hook turns from steps 2–5 never
appeared in Webex or the app outbox (replies go to the caller only).

## 8. Log hygiene

On the host, from the app directory (the token is fed to grep via a file
descriptor, never as an argument visible in `ps`):

```sh
journalctl --user -u nightshift-assistant --since '15 min ago' | grep -cFf <(sed -n 's/^NIGHTSHIFT_HOOK_TOKEN=//p' .env)
journalctl --user -u nightshift-assistant --since '15 min ago' | grep -c 'hook-smoke-ok'
```

**Expect:** `0` and `0` — the token, the turn text and the reply text never
reach the journal (hook lines carry messageId, source, status, latencyMs and
code only). Then `unset HOOK_TOKEN` on the off-tailnet machine.

Record the date, the Funnel hostname (not the token), each step's HTTP codes,
and the step-2 wall time in STATUS.md / `.verity/deploy-access.md`.

## Results — v0.16.0, 2026-10-17 (stage 40)

Host `3090-tuf`; Funnel hostname `3090-tuf.taile0ffc4.ts.net`. Off-tailnet path
from the operator workstation: the name forced to the public ingress answer
(`208.111.34.11`, from Cloudflare DoH) with `curl --resolve`, since on-tailnet
resolution (`100.110.222.42`) bypasses the edge.

| Step | Where | Result |
|---|---|---|
| 0 flag-off absence | loopback, dark deploy | `/hook/v1/messages` 404; schema 11; `/health` 200, `/api/v1/status` ok, app manifest 200, public `/webhook` 401 unsigned |
| 1 401 every path | edge | `/hook/v1/messages`, `/messages/<id>`, `/hook/v1/nope`: 401 no token, 401 wrong token |
| 2 200 sync | loopback | `PONG`, 200, 5.2 s wall (after the host re-auth below) |
| 2 200 sync | **edge**, authenticated | 200 `completed`, 6,149-char reply, **27.5 s** wall with `wait:55` (Funnel held the connection ≥ 27.5 s; full 55 s not exercised) |
| 3 202 + poll | loopback | `wait:0` → 202 + poll path; GET → `completed` |
| 4 idempotent re-POST | loopback | same `messageId` → stored state, no new turn |
| 5 429 | loopback | 4th POST in the burst → 429, `Retry-After: 4` |
| 6 nothing else exposed | edge | `/api/v1/status`, `/app/v1/health`, `/app/v1/manifest`, `/health`, `/`, `/hook`, `/hookv1`: all 404 |
| 7 Webex round-trip | — | **PENDING OWNER** (only the owner can message the bot) |
| 8 log hygiene | host journal | token 0, turn/reply text 0; 401 warn lines present (12 from probes; see issue #92) |

Incident during the run: the host Claude CLI lost its login at the first hook
turn (credentials rewritten 04:05:26Z, same pattern as 2026-09-08), which wedged
pending session `1b262322` ("Session ID … already in use"). Owner re-logged in;
operator closed session row 51 (`died`, DB backup
`nightshift-20261017-041049-pre-unwedge.db`) and the next turn started session
52 cleanly. Hook mechanics were unaffected.

### Port move — 2026-10-17 (owner decision)

The hook moved from `:443/hook/v1` to its own Funnel port,
`https://3090-tuf.taile0ffc4.ts.net:10000/hook/v1`. Re-verified at the edge:
`/hook/v1/*` returns 401 with no token. An authenticated sync request returned
200 `PONG10000`. `:10000` `/api/v1/status`, `/app/v1/health`, `/health`,
`/webhook` and `/` all return 404. Old `:443/hook/v1` returns 404. `:443/webhook`
still returns 401 when unsigned. For future runs, set `BASE=https://3090-tuf.taile0ffc4.ts.net:10000`.
