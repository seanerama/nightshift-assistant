# UI smoke — generative-UI DoD (Stage 35: the authoring flow, live, from the phone)

The brief's Definition of Done, certified end to end on the LIVE daemon: the
owner asks for a screen in chat → it appears in the phone app's Apps tab
functioning with zero granted tools; asks for a change → v2 of the same name;
asks for a page that wants a tool → in-chat approval → the tool is refused
before the grant and works after it. Deployed dark first (flag off = feature
absent), flag flipped deliberately, harness green flag-on, results recorded
in STATUS.md and the ops commit. Chat steps run from the owner's phone (the
nightshift-client app, or Webex — same session either way); CLI/door checks
run ON the prod host (loopback control API); MCP curls run from a desktop on
the tailnet.

Prereqs on the prod host (`.env`): `NIGHTSHIFT_CONTROL_ENABLED=true` +
`NIGHTSHIFT_API_TOKEN` set, `APP_TRANSPORT_ENABLED=true` +
`NIGHTSHIFT_APP_TOKEN` set. The app port is `NIGHTSHIFT_APP_PORT` (default
3778; **3779 on the current prod host** — see the stage-29 port deviation).
You need the host's tailnet IP and both token values. The chat steps need a
FRESH conversational session after each flag change (the preamble is
delivered at session start): `nightshift rotate` on the host after every
restart in this script, before chatting.

## 0. Flag off: the feature is absent (run FIRST — the shipped default)

With `NIGHTSHIFT_GENERATIVE_UI_ENABLED` unset (or `false`), on the host:

```sh
nightshift ui list
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
  "http://127.0.0.1:3777/api/v1/ui/resources"
```

**Expect:** the CLI reports the API error and exits non-zero; the curl prints
`404` (absent — NOT `403`). On the phone: the Apps tab shows ONLY the jobs
dashboard. In chat, ask "can you make me a custom screen?" — the assistant
must NOT advertise or attempt `nightshift ui` verbs (a dark feature is not
advertised; the preamble is absent). Any registry-backed resource in the Apps
tab with the flag off is a dark-launch breach — stop.

## 1. Flip the flag, then: a novel tracker from chat

Set `NIGHTSHIFT_GENERATIVE_UI_ENABLED=true` in the host `.env`, restart
(`sudo systemctl restart nightshift`), then `nightshift rotate` so the next
turn starts a session carrying the generative-UI preamble.

From the phone, in chat:

> make me a habit tracker with big buttons

**Expect, in order (the assistant narrates; verify each):**

- it checks the registry first (`nightshift ui list` — reuse-first rule)
  and finds no habit tracker;
- it generates the page, validates (`nightshift ui validate`), revising on
  violations, then installs (`nightshift ui install … --name <name>
  --provenance "…"` quoting your request) and tells you it is in the Apps
  tab — quoting the installed name/version, not just claiming success;
- the Apps tab (pull to refresh, or reopen) shows the new resource; opening
  it renders the tracker (static markup + `ui/ready` — it must not hang on
  a loading state);
- ZERO granted tools: on the host `nightshift ui show <name>` prints
  `granted: (none — zero-trust)`, and from the desktop the descriptor's
  allowlist is empty:

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** `ui://nightshift/<name>@v1` with `"ui/tools": []` — PRESENT and
EMPTY. Any `tools/call` the page attempts is refused by the client shell
(JSON-RPC `-32601`, per ui-bridge). A non-empty allowlist without a grant is
a zero-trust breach — stop.

## 2. Iteration: v2 under the same name, rollback works

From the phone, in chat:

> make the buttons bigger

**Expect:** the assistant iterates the EXISTING resource (same `--name` →
next version), not a new name. On the host:

```sh
nightshift ui show <name>
```

**Expect:** BOTH versions listed, v2 active. The Apps tab entry now renders
v2 (bigger buttons). Rollback:

```sh
nightshift ui activate <name> 1
nightshift ui show <name>
```

**Expect:** exit 0, v1 active again (v2 retained — nothing deleted), and the
Apps tab serves v1. (Asking the assistant "go back to the first version" and
seeing it run the activate itself is the full-marks variant.) Re-activate v2
if you prefer it before moving on.

## 3. Grants: refused before, works after

From the phone, in chat:

> show my jobs and let me kill them

**Expect:** the assistant authors/installs a page requesting tools (e.g.
`jobs_list,jobs_kill`) and then ASKS in chat — "this page requests
jobs_kill — allow?" — instead of granting on its own.

**Before answering**, verify the refusal path. From the desktop:

```sh
curl -sS -H "Authorization: Bearer $NIGHTSHIFT_APP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"ui://nightshift/<name>@v1"}}' \
  "http://<tailnet-ip>:3779/app/v1/mcp"
```

**Expect:** `"ui/tools": []` — and on the phone the page renders its static
fallback; any button that fires `tools/call` gets the shell's `-32601`
refusal (the page must degrade, not crash).

Now approve in chat ("yes, allow jobs_list and jobs_kill"). **Expect:** the
assistant runs `nightshift ui grant <name> <tool> --approval "…"` quoting
your approval message verbatim (verify on the host: `nightshift ui show
<name>` shows the granted tools; the ui_grants row carries your words).
Re-run the read curl: `"ui/tools"` now lists the granted tools. On the
phone, the page's live path works — jobs render, kill kills. If you REFUSE
instead: the grant is never run, and the assistant says plainly what will
not work.

## 4. Conformance harness against the live daemon, flag on

From a desktop on the tailnet:

```sh
npx agent-app-conformance http://<tailnet-ip>:3779 \
  --token "$NIGHTSHIFT_APP_TOKEN" --person-id "$WEBEX_OWNER_PERSON_ID"
```

**Expect:** exit 0. Known limitation: harness v1.0.0 hard-codes a 10s reply
window (agent-app-contract#13) — real-model turns can exceed it exactly as
in the stage-29 certification. If ONLY `outbox.reply`/`files.roundtrip` fail
on the timeout, record it as the stage-29 known-fail with the passing count;
any OTHER failing check names a daemon route — stop and file it.

## 5. Return to dark (optional — only if the feature is not going live yet)

Unset the flag (or set `false`), restart, `nightshift rotate`, and re-run
step 0. **Expect:** doors 404, Apps tab back to the jobs dashboard only, the
assistant no longer advertises `ui` verbs. Installed pages stay dormant in
SQLite — the SURFACE is what the flag removes. If the feature stays on,
record the flag flip + these results in STATUS.md and the ops commit
instead.

## Failure triage

- Step 1: the assistant says it cannot build screens with the flag ON → the
  session predates the flip — `nightshift rotate` and retry (the preamble
  only rides NEW sessions).
- Step 1: install fails validation repeatedly → read the verdicts it quotes;
  rule ids map 1:1 to ui-bridge clauses. Persistent `well-formed`/`bridge-only`
  failures on plausible HTML mean validator drift — file it, do not fight it.
- Step 1: `ui list`/install 404 with the flag on → the running daemon did
  not pick up `.env` (`systemctl show nightshift -p Environment`).
- Step 3: grant succeeds but `_meta` stays `[]` → the granted tool is not in
  the version's `requestedTools` (allowlist = granted ∩ requested) — grant
  what the page actually requests.
- Step 3: tools work BEFORE any grant → zero-trust breach — roll back
  immediately (flag off) and file it.
- Apps tab does not show the new resource → pull to refresh / reopen the
  connection; the list_changed stream (stage-34 smoke) is best-effort and
  the client re-lists on connect.
