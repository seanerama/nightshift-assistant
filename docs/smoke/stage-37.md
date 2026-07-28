# UI smoke — Stage 37 (ui-state store: seed via CLI → read via MCP → survives a version bump)

Verifies the live per-name state document end to end: with
`NIGHTSHIFT_GENERATIVE_UI_ENABLED=true`, the assistant can seed a resource's
state through `nightshift ui state --set`, a client reads the SAME document
back through the `ui_state_get` MCP tool (one table, two faces), and the
document survives an install-v2 + rollback ride untouched (state attaches to
the NAME — ADR 0015 symmetry). Flag off, the tools are absent from the
catalog (the certified five, byte-identical) and the doors 404. CLI/door
steps run ON the prod host (loopback control API); MCP steps run from a
desktop on the tailnet.

Prereqs on the prod host (`.env`): `NIGHTSHIFT_CONTROL_ENABLED=true` +
`NIGHTSHIFT_API_TOKEN` set, `APP_TRANSPORT_ENABLED=true` +
`NIGHTSHIFT_APP_TOKEN` set, `NIGHTSHIFT_GENERATIVE_UI_ENABLED=true` (restart
after editing). The app port is `NIGHTSHIFT_APP_PORT` (default 3778; **3779
on the current prod host** — see the stage-29 port deviation). You need the
host's tailnet IP and both token values.

## 0. Flag-off absence check (run FIRST when the flag is not yet on)

With `NIGHTSHIFT_GENERATIVE_UI_ENABLED` unset (or `false`):

On the host — the door is absent (404, NOT 403):

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
  "http://127.0.0.1:3777/api/v1/ui/state/smoke-state"
```

From the desktop — the catalog is EXACTLY the certified five:

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** `404` from the door; five tool names (`status`, `jobs_list`,
`jobs_submit`, `jobs_kill`, `session_rotate`) with NO `ui_state_*` entries.
A `ui_state_*` entry with the flag off is a certified-surface breach — stop.
Then enable the flag and restart (`sudo systemctl restart nightshift`) for
the remaining steps.

## 1. Install a page and seed its state via the CLI (on the host)

```sh
nightshift ui install test/fixtures/ui/good.html --name smoke-state \
  --tools ui_state_get,ui_state_set --provenance "stage-37 smoke"
nightshift ui state smoke-state
nightshift ui state smoke-state --set '{"habits":["water","stretch"],"streak":3}'
nightshift ui state smoke-state
```

**Expect:** install `version: 1`, `requested: ui_state_get, ui_state_set`
(a pre-Stage-37 daemon 422s this install — "unknown requested tool"). First
read: `updated: — (never set)`. After `--set`: `State set.` and the second
read shows the exact JSON back. (Name taken from an earlier smoke? Pick a
fresh `--name` and substitute it below.)

## 2. Read the SAME document over MCP tools/call (from the desktop)

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ui_state_get","arguments":{"name":"smoke-state"}}}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** a tool result (NOT `isError`) whose text body is
`{"ok":true,"name":"smoke-state","value":{"habits":["water","stretch"],"streak":3},"updatedAt":"<ts>"}`
— the CLI-seeded document, byte-for-byte. Also confirm `tools/list` now
shows seven tools, `status` first, `ui_state_get`/`ui_state_set` last.

Negative controls (tool-level errors, never protocol errors):

```sh
# unknown name → isError with the 404-class message
... "arguments":{"name":"no-such-page"} ...
```

**Expect:** `"isError": true` with `no registered resource named
"no-such-page"` in the body.

## 3. Write from the MCP side, read via the CLI (shared truth, reverse leg)

From the desktop:

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ui_state_set","arguments":{"name":"smoke-state","value":{"habits":["water","stretch"],"streak":4}}}}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

On the host: `nightshift ui state smoke-state`

**Expect:** the tool answers `{"ok":true,...}` with a fresh `updatedAt`; the
CLI read shows `"streak":4` — a FULL replace (last-write-wins), not a merge.

## 4. State survives a version bump and a rollback (on the host)

```sh
nightshift ui install test/fixtures/ui/good.html --name smoke-state \
  --provenance "stage-37 smoke v2"
nightshift ui state smoke-state
nightshift ui activate smoke-state 1
nightshift ui state smoke-state
```

**Expect:** install answers `version: 2`, `active: yes` — and BOTH state
reads still show `"streak":4` with the step-3 `updatedAt` unchanged. State
attaches to the name: iteration and rollback never touch it. This is the
exact data-loss the 2026-07-28 habit-tracker incident hit — any change here
is the bug back.

## 5. Caps hold live (on the host)

```sh
python3 -c 'import json; print(json.dumps({"value":"x"*70000}))' \
  | curl -sS -o /dev/null -w '%{http_code}\n' \
    -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
    -H 'content-type: application/json' -d @- \
    "http://127.0.0.1:3777/api/v1/ui/state/smoke-state"
nightshift ui state smoke-state
```

**Expect:** `422` (serialized cap is 65536 bytes) — and the follow-up read
still shows the step-3 document: a refused write changes nothing.
