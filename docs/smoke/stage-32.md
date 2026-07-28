# UI smoke — Stage 32 (versions & rollback: next-version install, show/activate)

Verifies versions-and-rollback live end to end: with
`NIGHTSHIFT_GENERATIVE_UI_ENABLED=true`, `nightshift ui install` on a taken
name assigns the NEXT version and makes it active (prior versions retained),
`ui show`/`ui activate` walk and flip the history, `resources/list` (MCP)
advertises exactly the ACTIVE `@vN` per name, and `resources/read` serves
BOTH versions' exact bytes — before and after rollback. Versions are never
deleted or edited: a change is the next version, rollback is re-activation.
CLI/door steps run ON the prod host (loopback control API); MCP steps run
from a desktop on the tailnet.

Prereqs: as stage-31 smoke (control + app transport on, both tokens in hand;
app port `NIGHTSHIFT_APP_PORT` — **3779 on the current prod host**), plus
`NIGHTSHIFT_GENERATIVE_UI_ENABLED=true` and the stage-31 smoke already run,
so `smoke-hello@v1` is installed and listed. If it is not, run stage-31
steps 1–3 first.

## 0. Flag-off absence check (only if returning from dark)

With the flag unset/false, the Stage 32 doors are as absent as the rest of
the family:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
  "http://127.0.0.1:3777/api/v1/ui/resources/smoke-hello"
```

**Expect:** `404` (absent — NOT `403`). Same for
`.../smoke-hello/1` and `POST .../smoke-hello/activate`. Re-enable the flag
and restart before continuing.

## 1. Install a SECOND version under the taken name (on the host)

Make a visibly different page, then install it under the existing name:

```sh
cp test/fixtures/ui/good.html /tmp/smoke-hello-v2.html
sed -i 's|<h1>Hello from a valid resource</h1>|<h1>Hello from v2</h1>|' /tmp/smoke-hello-v2.html
nightshift ui install /tmp/smoke-hello-v2.html --name smoke-hello \
  --provenance "stage-32 smoke v2"
nightshift ui show smoke-hello
```

**Expect:** install prints `version: 2`, `active: yes` (NOT a refusal — the
stage-31 "taken name refuses" behavior is gone by contract); show prints
`smoke-hello (active: v2)` with BOTH rows — v1 `active: no`, v2
`active: yes`. A refusal here means a pre-stage-32 build.

Negative control (transactionality — nothing may move on a failed install):

```sh
nightshift ui install test/fixtures/ui/bad-no-network.html --name smoke-hello
nightshift ui show smoke-hello
```

**Expect:** non-zero exit with the `no-network` verdict; show still lists
exactly v1 + v2 with v2 active — the failed install consumed no version
number and moved no pointer.

## 2. Observe v2 active over MCP (from the desktop)

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** `ui://nightshift/jobs@v1` plus EXACTLY ONE smoke-hello entry —
`ui://nightshift/smoke-hello@v2`. `@v1` must NOT be listed (the list
advertises the active version only; growth is bounded by names, not
versions).

Read BOTH versions — the retained v1 must still serve its old bytes:

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"ui://nightshift/smoke-hello@v1"}}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"ui://nightshift/smoke-hello@v2"}}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** both reads succeed (a listed client can always read what it saw
listed, and rollback needs the old bytes): `@v1` contains
"Hello from a valid resource", `@v2` contains "Hello from v2". Either read
failing `unknown resource` is a retention breach — stop.

## 3. Rollback (on the host), re-observe (from the desktop)

```sh
nightshift ui activate smoke-hello 1
nightshift ui show smoke-hello
```

**Expect:** activate prints `Activated.` with `version: 1`, `active: yes`;
show now marks v1 active, v2 inactive — still two rows, nothing deleted.
Then re-run the step-2 `resources/list`:

**Expect:** the smoke-hello entry is back to
`ui://nightshift/smoke-hello@v1` — and BOTH reads still succeed with the
same bytes as step 2. That is the full v1→v2→rollback sequence observed
live.

Negative control:

```sh
nightshift ui activate smoke-hello 9
nightshift ui show no-such-name
```

**Expect:** both exit non-zero with a not-found error; `ui show smoke-hello`
is unchanged (v1 still active).

## 4. Clean up (optional)

Roll forward again if v2 is the desired live version
(`nightshift ui activate smoke-hello 2`), and remove
`/tmp/smoke-hello-v2.html`. Versions themselves are never deleted — that is
the contract, not a smoke leftover.

## Failure triage

- Step 1 refuses "already registered" → the running daemon predates
  Stage 32 — redeploy.
- Step 2 lists BOTH smoke-hello uris → active-pointer breach (two active
  rows, or list() not filtering) — roll back the deploy and file it.
- Step 2 `@v1` read fails after the v2 install → versions are being
  deleted/edited on install — retention breach, roll back.
- Step 3 list still shows `@v2` after activate → the activate transaction
  moved the pointer in SQLite but the MCP list is served from a stale
  process — confirm one daemon instance and one `NIGHTSHIFT_DB`.
