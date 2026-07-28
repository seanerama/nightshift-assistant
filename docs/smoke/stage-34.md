# UI smoke — Stage 34 (list_changed: GET /app/v1/mcp stream, frame on every registry mutation)

Verifies the live notification half of contracts/generative-ui.md §MCP:
`GET /app/v1/mcp` (with `Accept: text/event-stream`) opens the
streamable-HTTP spec's SSE stream, and each registry mutation — `ui
install`, `ui activate`, `ui grant`, `ui revoke` — puts exactly one
`notifications/resources/list_changed` frame on it. Zero listeners is
normal (best-effort by spec): mutations behave identically with no stream
open. The certified POST path is untouched apart from `initialize` now
advertising `resources: { listChanged: true }`. Mutations run ON the prod
host (loopback control API); the stream is read from a desktop on the
tailnet.

Prereqs on the prod host (`.env`): `NIGHTSHIFT_CONTROL_ENABLED=true` +
`NIGHTSHIFT_API_TOKEN` set, `APP_TRANSPORT_ENABLED=true` +
`NIGHTSHIFT_APP_TOKEN` set, `NIGHTSHIFT_GENERATIVE_UI_ENABLED=true`
(restart after editing). The app port is `NIGHTSHIFT_APP_PORT` (default
3778; **3779 on the current prod host** — see the stage-29 port deviation).

## 0. Gate checks (from the desktop)

```sh
# No bearer → 401 before anything (the stream is not enumerable).
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Accept: text/event-stream' "http://<tailnet-ip>:3779/app/v1/mcp"

# Bearer but no text/event-stream in Accept → 406 (MCP spec: the client
# MUST list it; this is the SDK transport's own rejection).
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'Accept: application/json' "http://<tailnet-ip>:3779/app/v1/mcp"

# DELETE stays 405 — "no session termination", exactly as before.
curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE \
  -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** `401`, `406`, `405` in that order.

## 1. Zero-listener normalcy (on the host, NO stream open yet)

```sh
nightshift ui install test/fixtures/ui/good.html --name smoke-lc \
  --tools jobs_list --provenance "stage-34 smoke"
```

**Expect:** exit 0, `version: 1`, `active: yes` — a mutation with zero open
streams is byte-identical to before this stage (best-effort by spec). (Name
taken by an earlier smoke? Pick a fresh `--name` and substitute below.)

## 2. Open the stream (from the desktop, leave it running)

```sh
curl -N -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'Accept: text/event-stream' "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** the connection stays open; `: stream open` appears immediately,
then `: keep-alive` comments every ~15s. No data frames yet — nothing has
mutated since the stream opened.

## 3. Mutate → one frame each (on the host, stream still open)

Run these one at a time, watching the curl window after each:

```sh
nightshift ui install test/fixtures/ui/good.html --name smoke-lc \
  --tools jobs_list --provenance "stage-34 smoke v2"      # register (v2)
nightshift ui activate smoke-lc 1                          # rollback
nightshift ui grant smoke-lc jobs_list --approval "stage-34 smoke yes"
nightshift ui revoke smoke-lc jobs_list
```

**Expect:** after EACH command, exactly ONE frame arrives on the stream:

```
event: message
data: {"jsonrpc":"2.0","method":"notifications/resources/list_changed"}
```

Four commands → four frames, no more (a doubled frame per mutation is a
bug). A `resources/list` POST from the desktop after the ride shows
`smoke-lc@v1` active — the notification told the client to re-list; the
list itself is the same certified POST surface.

## 4. Capability + POST path unchanged (from the desktop)

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** `"resources":{"listChanged":true}` inside
`result.capabilities`; tools/resources answers are otherwise identical to
Stage 33.

## 5. Disconnect resilience

Ctrl-C the curl from step 2, then on the host run another mutation
(`nightshift ui grant smoke-lc jobs_list --approval "re-approved"`).

**Expect:** exit 0 — a vanished listener never blocks or fails a mutation.
Re-open the step-2 curl: fresh stream, next mutation's frame arrives (the
stream has no replay — only mutations after it opened appear; that is the
design, the client re-lists on connect).

## Failure triage

- Step 2 gets `405` → the daemon predates Stage 34 (stale build) — the GET
  arm never mounted.
- Step 3 shows no frame but the CLI exits 0 → the hub is not shared across
  the two doors (control API mutation, app transport stream) — wiring
  regression in src/app.ts.
- Frames arrive with the generative-ui flag OFF → impossible by
  construction (the mutation doors 404 when dark); if seen, the flag gate
  regressed — stop and roll back.
- Step 5's mutation fails or the daemon logs an unhandled write error → the
  write-after-end guard regressed in the hub (src/transport/app/mcp.ts).
