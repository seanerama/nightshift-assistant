# UI smoke — Stage 28 (jobs dashboard resource over the tailnet)

Verifies the live `ui://nightshift/jobs@v1` resource from a REAL client on
the tailnet: MCP Inspector lists and reads the resource with its
`_meta["ui/tools"]` declaration intact, and the HTML opened standalone in a
plain browser renders the degradable shell — not a blank page. Run on a
desktop that is on the tailnet (NOT on the prod host itself — loopback would
not prove the tailnet bind) after the Stage 29 deploy.

Prereqs on the prod host (`.env`): `APP_TRANSPORT_ENABLED=true`,
`NIGHTSHIFT_APP_TOKEN` set, app port 3778 (`NIGHTSHIFT_APP_PORT`). You need
the tailnet IP of the host and the token value.

## 1. Manifest declares mcp-apps-ui

From the desktop:

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  "http://<tailnet-ip>:3778/app/v1/manifest"
```

**Expect:** `capabilities` contains `"mcp-apps-ui"` (beside `"chat"`,
`"files"`, `"mcp-tools"`). If it is absent, the deployed build predates this
stage — stop.

## 2. MCP Inspector connects

```sh
npx @modelcontextprotocol/inspector
```

In the Inspector UI:

- Transport: **Streamable HTTP**
- URL: `http://<tailnet-ip>:3778/app/v1/mcp`
- Authentication → Bearer token: the `NIGHTSHIFT_APP_TOKEN` value
- Connect.

**Expect:** the connection succeeds (stateless — no session id appears; that
is correct). A 401 with the token pasted correctly means the token in `.env`
and the one you used differ.

## 3. List the resource

Inspector → Resources → List Resources.

**Expect:** EXACTLY one resource:

- uri `ui://nightshift/jobs@v1`, name `jobs`, mimeType `text/html`
- the descriptor's `_meta` carries `"ui/tools": ["jobs_list", "jobs_kill",
  "jobs_submit"]` — exactly those three names, in the descriptor's `_meta`
  (that is what the client app derives the allowlist from, per
  `nightshift-client/contracts/ui-bridge.md`; anywhere else = the dashboard
  gets an empty allowlist and every call is refused).

A second resource, a missing `_meta`, or a fourth tool name is a drift
against ADR 0012 — file it, do not proceed.

## 4. Read the resource

Inspector → Resources → select `ui://nightshift/jobs@v1` → Read.

**Expect:** one `text/html` contents entry whose text is the full dashboard
HTML — it starts with the provenance header comment citing
`nightshift-client/contracts/ui-bridge.md`, and contains "Nightshift jobs".
The tools half is untouched: Tools → List Tools still shows exactly the five
Stage 27 tools.

## 5. Standalone render is degradable, never blank

Save the read HTML to a file and open it in a plain desktop browser (or open
the repo copy directly):

```sh
# from a checkout at the deployed version
xdg-open src/transport/app/resources/jobs-v1.html   # macOS: open
```

**Expect:** a rendered page — header "Nightshift jobs", a visible banner
"**Tools unavailable.**" explaining no ui-bridge is answering, the status
filter / Refresh / submit form present but DISABLED, and the note
"standalone preview — no live data". The browser console shows NO uncaught
errors. A blank page or a console exception is a ui-bridge "render
degradable" violation — file it.

## 6. Negative control — no token, no surface

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' \
  "http://<tailnet-ip>:3778/app/v1/mcp"
```

**Expect:** `401`. The resource surface sits behind the same bearer gate as
everything else; anything but 401 is a security regression — roll back.

## Failure triage

- Step 3 lists zero resources but tools list fine → the deployed build has
  the Stage 27 mcp.ts without the Stage 28 resource handlers (stale build).
- Step 3 lists the resource but `_meta` is missing/misplaced → the client
  app will fail closed (empty allowlist): the dashboard renders but every
  action errors. That is the designed failure mode — fix the descriptor, not
  the client.
- Step 4 read fails with `unknown resource` → uri mismatch; the uri is
  case-sensitive and versioned: `ui://nightshift/jobs@v1` exactly.
- Step 5 renders but the console shows an uncaught error → treat as a
  blocking bug even though something painted; the shell's fallback replaces
  the view on render crashes, so the app user would lose the dashboard.
- Driving the dashboard's kill/submit buttons against live is NOT part of
  this smoke — that is the client app's Stage (nightshift-client) and the
  mutating tools behave exactly like `nightshift kill` / job submit, covered
  by the test suite.
