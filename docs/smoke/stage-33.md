# UI smoke — Stage 33 (zero-trust grants: grant → _meta appears → revoke → gone)

Verifies the live grant machinery end to end: with
`NIGHTSHIFT_GENERATIVE_UI_ENABLED=true`, an installed page's
`_meta["ui/tools"]` starts EMPTY (zero-trust), `nightshift ui grant` makes
the granted tool appear on BOTH `resources/list` and `resources/read`,
`nightshift ui revoke` makes it disappear again immediately, and the
`ui_grants` history survives the whole ride (revoked rows retained, re-grant
is a new row). The hand-authored `ui://nightshift/jobs@v1` never moves.
CLI/door steps run ON the prod host (loopback control API); MCP steps run
from a desktop on the tailnet.

Prereqs on the prod host (`.env`): `NIGHTSHIFT_CONTROL_ENABLED=true` +
`NIGHTSHIFT_API_TOKEN` set, `APP_TRANSPORT_ENABLED=true` +
`NIGHTSHIFT_APP_TOKEN` set, `NIGHTSHIFT_GENERATIVE_UI_ENABLED=true` (restart
after editing). The app port is `NIGHTSHIFT_APP_PORT` (default 3778; **3779
on the current prod host** — see the stage-29 port deviation). You need the
host's tailnet IP and both token values.

## 0. Flag-off absence check (run FIRST when the flag is not yet on)

With `NIGHTSHIFT_GENERATIVE_UI_ENABLED` unset (or `false`), on the host:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"smoke-grants","tool":"jobs_list","approvalText":"x"}' \
  "http://127.0.0.1:3777/api/v1/ui/grants"
```

**Expect:** `404` (absent — NOT `403`), same as the rest of the ui family.
Then enable the flag and restart (`sudo systemctl restart nightshift`) for
the remaining steps.

## 1. Install a page that requests a tool (on the host)

```sh
nightshift ui install test/fixtures/ui/good.html --name smoke-grants \
  --tools jobs_list --provenance "stage-33 smoke"
```

**Expect:** `version: 1`, `active: yes`, `requested: jobs_list`,
`granted: (none — zero-trust)`. (Name taken from an earlier smoke? Pick a
fresh `--name` and substitute it below.)

## 2. Baseline: the allowlist is empty over MCP (from the desktop)

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** `ui://nightshift/smoke-grants@v1` present with
`"ui/tools": []` — PRESENT and EMPTY. A non-empty array before any grant is
a zero-trust breach — stop.

## 3. Grant → the tool appears

On the host:

```sh
nightshift ui grant smoke-grants jobs_list \
  --approval "owner said yes to jobs_list in chat, stage-33 smoke"
```

**Expect:** exit 0, a grant block with `tool: jobs_list`, `revoked: —`, and
the approval text echoed back. Idempotency check — run the SAME command
again: exit 0, and the ORIGINAL `granted:` timestamp comes back (no
duplicate).

From the desktop, re-run the step-2 list AND a read:

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"ui://nightshift/smoke-grants@v1"}}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** `"ui/tools": ["jobs_list"]` on BOTH the list descriptor and the
read contents. `ui://nightshift/jobs@v1` still carries exactly its Stage 28
three tools — any change there is a breach.

## 4. Revoke → gone again

On the host:

```sh
nightshift ui revoke smoke-grants jobs_list
```

**Expect:** exit 0, the grant block now shows a `revoked:` timestamp. Re-run
the step-3 list/read curls: `"ui/tools": []` on both — revocation is
immediate, no restart involved.

Negative controls (nothing may be written):

```sh
nightshift ui grant smoke-grants jobs_promote --approval "x"   # unknown tool
nightshift ui grant no-such-page jobs_list --approval "x"      # unknown resource
nightshift ui revoke smoke-grants jobs_list                    # already revoked
```

**Expect:** all three exit non-zero (the daemon answers 422, 404, 404
respectively via `--json`).

## 5. History is durable (on the host)

```sh
sqlite3 <NIGHTSHIFT_DB path> \
  "SELECT tool, granted_at, revoked_at FROM ui_grants WHERE name='smoke-grants' ORDER BY id;"
```

**Expect:** the revoked row is STILL THERE with `revoked_at` set. Re-grant
(`nightshift ui grant smoke-grants jobs_list --approval "re-approved"`) and
re-query: a SECOND row, `revoked_at` empty — and the step-3 curls show
`["jobs_list"]` again. Rows are never deleted; a missing row means something
deleted history — file it immediately.

## Failure triage

- Step 3 grant 404s with the flag on → the name is not registered (typo, or
  the install landed on a different DB — `NIGHTSHIFT_DB` mismatch).
- Step 3 grants but `_meta` stays `[]` → the granted tool is not in the
  page's `requestedTools` (the served allowlist is granted ∩ requested per
  version — grant the tool the page actually requests) or a stale build
  predating Stage 33.
- `jobs@v1` `_meta` changed anywhere in this smoke → the static allowlist
  consulted the grants table; that is a Stage 33 regression — roll back.
- Interactive tool-call certification from inside the client app is Stage 35
  scope; this smoke certifies the daemon-side allowlist derivation the
  client shell consumes.
