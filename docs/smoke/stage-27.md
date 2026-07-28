# UI smoke — Stage 27 (app MCP tools over the tailnet)

Verifies the live `/app/v1/mcp` endpoint from a REAL client on the tailnet:
MCP Inspector connects with the bearer token, lists exactly the five tools,
and calls the two read-only doors. Run on a desktop that is on the tailnet
(NOT on the prod host itself — loopback would not prove the tailnet bind)
after the Stage 29 deploy.

Prereqs on the prod host (`.env`): `APP_TRANSPORT_ENABLED=true`,
`NIGHTSHIFT_APP_TOKEN` set, app port 3778 (`NIGHTSHIFT_APP_PORT`). You need
the tailnet IP of the host and the token value.

## 1. Manifest declares mcp-tools

From the desktop:

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  "http://<tailnet-ip>:3778/app/v1/manifest"
```

**Expect:** `capabilities` contains `"mcp-tools"` (beside `"chat"`,
`"files"`). If it is absent, the deployed build predates this stage — stop.

## 2. MCP Inspector connects

```sh
npx @modelcontextprotocol/inspector
```

In the Inspector UI:

- Transport: **Streamable HTTP**
- URL: `http://<tailnet-ip>:3778/app/v1/mcp`
- Authentication → Bearer token: the `NIGHTSHIFT_APP_TOKEN` value
- Connect.

**Expect:** the connection succeeds (the server is stateless — no session id
appears; that is correct, not a failure). A red/401 failure with the token
pasted correctly means the token in `.env` and the one you used differ.

## 3. List the five tools

Inspector → Tools → List Tools.

**Expect:** EXACTLY five tools, no more, no fewer:
`status`, `jobs_list`, `jobs_submit`, `jobs_kill`, `session_rotate` — each
with a description and an input schema. A sixth tool (or a missing one) is a
capability drift against ADR 0012 — file it, do not proceed.

## 4. Call status

Run the `status` tool with no arguments.

**Expect:** a JSON text result with `ok: true`, the deployed `version`,
`uptimeSec`, `session { id, turns }`, `jobs { queued, running, succeeded,
failed, killed }`, `rotation.enabled`, `jobsEnabled` — the same fields
`nightshift status --json` shows over SSH. Cross-check one value (e.g.
`version`) against the CLI:

```sh
ssh <prod-host> nightshift status --json
```

Any field mismatch between the two doors is a parity bug by definition.

## 5. Call jobs_list

Run `jobs_list` with no arguments (and once with `{"status": "succeeded"}`).

**Expect:** `ok: true` and a `jobs` array of JobRecords matching
`nightshift jobs --json` — same ids, same statuses. The filtered call returns
the subset only.

## 6. Negative control — no token, no surface

From the desktop, without the token:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  "http://<tailnet-ip>:3778/app/v1/mcp"
```

**Expect:** `401`. Anything else (404, 200, a hang) means the bearer gate is
not in front of the MCP door — treat as a security regression and roll back.

## Failure triage

- Step 2 cannot connect at all → confirm the desktop is on the tailnet and
  the host's app transport is up: `curl` the health route with the token. If
  health answers but `/mcp` 404s, the deployed manifest lacks `mcp-tools`
  (stale build).
- Step 3 lists zero tools but initialize worked → the SDK server registered
  no handlers; capture the daemon log (`app mcp handler error` lines) and
  file it.
- Step 4/5 disagree with the CLI → both are thin doors over the same
  internals (ADR 0012); a divergence is a bug — capture both outputs
  verbatim in the issue.
- Mutating tools (`jobs_kill`, `session_rotate`) are NOT part of this smoke:
  do not fire them against live just to see; they are covered by the test
  suite and behave exactly like `nightshift kill` / `nightshift rotate`.
