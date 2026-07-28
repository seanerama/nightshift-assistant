# UI smoke — Stage 31 (generative-UI registry rows on the MCP resource list)

Verifies the live generative-UI walking skeleton end to end: with
`NIGHTSHIFT_GENERATIVE_UI_ENABLED=true`, a valid single-file page installed
through `nightshift ui install` appears on `resources/list` as
`ui://nightshift/<name>@v1` with the zero-trust empty allowlist
(`_meta["ui/tools"]: []`), `resources/read` returns the exact HTML — and with
the flag off (the shipped default) the feature is ABSENT everywhere: the
`/api/v1/ui/*` doors 404 and the MCP list is byte-identical to Stage 28 (the
hand-authored jobs entry only). CLI/door steps run ON the prod host
(loopback control API); MCP steps run from a desktop on the tailnet.

Prereqs on the prod host (`.env`): `NIGHTSHIFT_CONTROL_ENABLED=true` +
`NIGHTSHIFT_API_TOKEN` set, `APP_TRANSPORT_ENABLED=true` +
`NIGHTSHIFT_APP_TOKEN` set. The app port is `NIGHTSHIFT_APP_PORT` (default
3778; **3779 on the current prod host** — see the stage-29 port deviation).
You need the host's tailnet IP and both token values.

## 0. Flag-off absence check (run FIRST — the shipped default)

With `NIGHTSHIFT_GENERATIVE_UI_ENABLED` unset (or `false`), on the host:

```sh
nightshift ui list
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
  "http://127.0.0.1:3777/api/v1/ui/resources"
```

**Expect:** the CLI reports the API error and exits non-zero; the curl prints
`404` (absent — NOT `403`). Then from the desktop:

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** EXACTLY one resource, `ui://nightshift/jobs@v1`, with its
Stage 28 `_meta` (`"ui/tools": ["jobs_list", "jobs_kill", "jobs_submit"]`) —
byte-identical to the Stage 28 smoke. Any second resource with the flag off
is a dark-launch breach — roll back.

## 1. Enable the flag

Set `NIGHTSHIFT_GENERATIVE_UI_ENABLED=true` in the host `.env` and restart
the daemon (`sudo systemctl restart nightshift`). The remaining steps assume
the flag is on.

## 2. Validate, then install, a known-good page (on the host)

Use the repo's known-good fixture (at the deployed version):

```sh
nightshift ui validate test/fixtures/ui/good.html
nightshift ui install test/fixtures/ui/good.html --name smoke-hello \
  --tools jobs_list --provenance "stage-31 smoke"
nightshift ui list
```

**Expect:** validate prints `Valid.` and exits 0; install prints the record —
`version: 1`, `active: yes`, `requested: jobs_list`,
`granted: (none — zero-trust)`; list shows the one row. A validation failure
here on the pristine fixture means validator drift — stop and file it.

Negative control (nothing may be written on refusal):

```sh
nightshift ui install src/transport/app/resources/jobs-v1.html --name jobs
```

**Expect:** non-zero exit, "reserved" in the error, and `nightshift ui list`
still shows only `smoke-hello`.

## 3. List the resource over MCP (the observably-works check)

From the desktop — plain curl:

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

or MCP Inspector (`npx @modelcontextprotocol/inspector`, Streamable HTTP,
URL `http://<tailnet-ip>:3779/app/v1/mcp`, bearer = the app token) →
Resources → List Resources.

**Expect:** EXACTLY two resources:

- `ui://nightshift/jobs@v1` — unchanged from Stage 28, its three ui/tools
  intact;
- `ui://nightshift/smoke-hello@v1` — `mimeType: text/html`, and the
  descriptor's `_meta` carries `"ui/tools": []` — PRESENT and EMPTY. The
  page requested `jobs_list` but nothing is granted (grants land in
  Stage 33): the client shell must derive an empty allowlist. A non-empty
  array here is a zero-trust breach — roll back, do not proceed.

## 4. Read the resource

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"ui://nightshift/smoke-hello@v1"}}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

(or Inspector → Resources → `ui://nightshift/smoke-hello@v1` → Read.)

**Expect:** one `text/html` contents entry whose text is the installed
fixture byte-for-byte (starts with the fixture's header comment, contains
"Hello from a valid resource"), `_meta` again `"ui/tools": []`. Tools →
List Tools still shows exactly the five Stage 27 tools.

## 5. Return to dark

Unset the flag (or set `false`), restart, and re-run step 0.

**Expect:** the doors 404 again and the MCP list is back to the jobs entry
only — the installed row stays dormant in SQLite (state survives; the
SURFACE is what the flag removes).

## Failure triage

- Step 2 install 404s → the flag is not on for the running daemon (restart
  after editing `.env`; `systemctl show nightshift -p Environment` to
  confirm what it sees).
- Step 3 lists `smoke-hello` but `_meta["ui/tools"]` is missing → the client
  shell fails closed (empty allowlist), but the descriptor is still wrong —
  fix the daemon, not the client.
- Step 3 still lists one resource with the flag on → stale build predating
  Stage 31, or the install landed on a different DB than the daemon reads
  (`NIGHTSHIFT_DB` mismatch).
- Step 4 read fails `unknown resource` → uri mismatch; it is case-sensitive
  and versioned: `ui://nightshift/smoke-hello@v1` exactly.
- Driving an installed page inside the client app is NOT part of this smoke
  — no tools are granted this stage, so a page can only render statically
  and signal `ui/ready`; interactive certification arrives with grants
  (Stage 33) and the authoring flow (Stage 35).
