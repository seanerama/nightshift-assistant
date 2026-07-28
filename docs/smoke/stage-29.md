# Live certification — Stage 29 (app transport live on the tailnet)

> **FILLED 2026-07-28 by the Release/Deploy Operator.** Result: **PARTIAL —
> 7 of 8 steps pass with pasted evidence; step 4 (harness exit 0) FAILS on an
> upstream harness limitation** (hard-coded 10s reply window vs real-model
> latency — `agent-app-contract#13`; contract-v1.0.1 candidate). Certification
> is therefore NOT claimed; see STATUS.md. Owner-only items (Webex inbound,
> Inspector GUI, phone Stage-0 exit) remain PENDING OWNER.
>
> **Port deviation:** all steps ran against port **3779**, not the template's
> 3778 — pre-flight found `my-c-sweet.service` (a separate Webex-fronted
> daemon) already bound to 127.0.0.1:3778 with its own pre-existing Funnel
> route `/csweet/webhook`. `NIGHTSHIFT_APP_PORT=3779` set in the host .env;
> no code change (the port was a config knob by design).

Certifies the deployed `/app/v1/` surface on the production daemon, from the
tailnet, per `stage-instructions/stage-29-app-transport-deploy-dark-and-certify-live-on-the-tailnet.md`
(steps 3a–3f quoted verbatim below), `contracts/app-ingress.md`, and ADR 0011.

**Prereqs**

- v0.13.0 deployed via `./deploy.sh v0.13.0` at 2026-07-28T14:44Z (dark deploy
  first — "app transport: dark" confirmed — then flag enabled + redeploy;
  token generated on first enable, never printed). DB backup taken pre-deploy:
  `~/backups/nightshift/nightshift-20260728-144248.db`.
- Second tailnet machine: the operator workstation (WSL2, tailnet member),
  `URL=http://100.110.222.42:3779`.

  EVIDENCE (before):

  ```
  # Funnel on:
  #     - https://3090-tuf.taile0ffc4.ts.net
  https://3090-tuf.taile0ffc4.ts.net (Funnel on)
  |-- /webhook        proxy http://127.0.0.1:3777/webhook
  |-- /csweet/webhook proxy http://127.0.0.1:3778/csweet/webhook
  ```

  NOTE: the template expected `/webhook` only. The second route PRE-EXISTS
  this release and belongs to my-c-sweet (port 3778 — that service's port,
  not the app transport's). Neither route targets 3779. The step-8 gate is
  "byte-identical before/after," which holds (see step 8).

## 0. Resolve the env-path discrepancy (flagged 2026-07-24)

EVIDENCE (confirmed path + records corrected):

```
$ ls -d ~/apps/nightshift-assistant ~/nightshift-assistant 2>/dev/null
/home/smahoney/apps/nightshift-assistant        # <- only this exists
```

Only `~/apps/nightshift-assistant` exists on the host; deploy.sh git-checkouts
and restarts there, and the units' EnvironmentFile points at its `.env`.
`.verity/deploy-access.md`'s `~/nightshift-assistant/.env` line was the stale
record → corrected 2026-07-28. STATUS.md was already right.

## 1. (3a) Bind check on the host

EVIDENCE:

```
$ ss -tlnp | grep 3779
LISTEN 0  511  100.110.222.42:3779  0.0.0.0:*  users:(("node",pid=509537,fd=26))
LISTEN 0  511       127.0.0.1:3779  0.0.0.0:*  users:(("node",pid=509537,fd=25))
```

PASS — exactly loopback + tailnet IP; no 0.0.0.0, no [::], no other interface.

## 2. (3b) 401 without token (real AND fake path); manifest with token

EVIDENCE (token redacted; run from the tailnet machine):

```
no-token real path  (GET /app/v1/health):                 401
no-token fake path  (GET /app/v1/definitely-not-a-route): 401
bad-token           (GET /app/v1/health):                 401
with token (GET /app/v1/manifest):
{"schema":1,"agent":{"name":"nightshift-assistant","version":"0.1.0"},
 "contract":{"name":"app-ingress","version":1},
 "capabilities":["chat","files","mcp-tools","mcp-apps-ui"]}
```

PASS — 401 precedes 404 on real and fake paths; manifest lists exactly the
four capabilities.

## 3. (3c) SSE client observes a REAL ack + reply

EVIDENCE (SSE stream from the tailnet machine; POST returned 202):

```
POST /app/v1/messages -> {"ok":true,"messageId":"e9445aaf-5ceb-4027-aa06-333f3b22cd9c"}  202

id: 1
data: {"schema":1,"id":1,"type":"ack","at":"2026-07-28T14:45:24.599Z","payload":{"messageId":"e9445aaf-..."}}

id: 2
data: {"schema":1,"id":2,"type":"reply","at":"2026-07-28T14:45:31.953Z","payload":{"schema":1,"text":"certified","files":[],"sessionId":"91eb40e8-61f3-4a37-b051-9d5644e58c0f","rotated":false}}

: keep-alive
```

PASS — 202, then ack (id 1) → REAL reply (id 2, live session text
"certified", 7.4s turn), contiguous ids, keep-alive comment observed.

## 4. (3d) Conformance harness from the tailnet → exit 0

EVIDENCE (two runs, token redacted):

```
PASS  messages.202 ... (21 checks pass, 0 skipped)
FAIL  outbox.reply     no reply event within 10000ms. Got types: ["ack"]
FAIL  files.roundtrip  no reply event arrived within 10000ms to carry the attachment back
FAIL — 21 passed, 2 failed, 0 skipped   exit=1   (both runs identical)
```

**FAIL — exit 0 NOT achieved; certification NOT claimed.** Diagnosis: the
harness v1.0.0 hard-codes a 10s reply window with no knob
(`agent-app-conformance --help` offers none). Production relays to a REAL
model; turns exceed 10s under the harness's prompts. Counter-evidence that
the daemon itself conforms: step 3's real reply in 7.4s, the harness's own
messages receiving real replies AFTER its window (outbox ids 10–11), and CI
(instant agent stub) passing 23/23. Filed upstream:
**seanerama/agent-app-contract#13** (`--reply-timeout-ms`, contract-v1.0.1
candidate). Re-run this step when it lands. Per the triage rule ("the failing
check names the route; anything broken live goes back through /verity:plan")
— no daemon defect was found to intake.

## 5. (3e) Webex round-trip — dual-run proven

EVIDENCE (send leg; timestamped):

```
14:49:05 job submitted (host CLI): bd0863c8 "stage-29 dual-run notice" (type test)
14:50:0x job succeeded; job-finish notice fan-out:
  - Webex leg: delivered (journal: zero "send failed"/"fallback send" lines in window)
  - app leg:   outbox event id 12, type notice: "✅ **stage-29 dual-run notice** — test finished..."
```

PARTIAL PASS — the OUTBOUND Webex leg + app fan-out are proven live with a
real job notice. The INBOUND leg (owner messages the bot in Webex, normal
reply arrives) is **PENDING OWNER** — only the owner can message the bot
(same constraint as the v0.12.2 record).

## 6. (3f) MCP Inspector + UI resource per the Stage 27/28 smokes

EVIDENCE (protocol-level, via curl JSON-RPC from the tailnet machine):

```
tools/list           -> five tools: status, jobs_list, jobs_submit, jobs_kill, session_rotate
tools/call status    -> {"ok":true,"version":"0.1.0","uptimeSec":89,"session":{"id":"91eb40e8-...","turns":1},
                        "jobs":{"queued":0,"running":0,"succeeded":16,"failed":9,"killed":3},...}
resources/list       -> ui://nightshift/jobs@v1, mimeType text/html,
                        _meta {"ui/tools":["jobs_list","jobs_kill","jobs_submit"]}
resources/read       -> 15954 bytes, provenance header cites ui-bridge.md, _meta intact
no-token POST /mcp   -> 401
```

PARTIAL PASS — every wire-level assertion of both smokes verified live. The
Inspector GUI session itself (docs/smoke/stage-27.md / stage-28.md as
written, from a desktop) is **PENDING OWNER** (equivalents proven above).

## 7. Rollback drill — kill-switch verified once, then re-enabled

EVIDENCE (disable → vanish → daemon healthy → re-enable → manifest OK):

```
flag=false + restart:  service active; curl /app/v1/health -> connect failure
                       (exit 7 — no listener; routes VANISHED, not 403/404)
                       journal: zero send failures (Webex leg unaffected)
flag=true  + restart:  service active; ss shows both 3779 listeners;
                       GET /app/v1/health with token -> 200
```

PASS — kill-switch works exactly as documented; daemon healthy throughout.
(Webex inbound during the drill: PENDING OWNER, as in step 5.)

## 8. Funnel scope unchanged (after)

EVIDENCE (after — diffed against before):

```
$ diff /tmp/funnel-before.txt /tmp/funnel-after.txt && echo "funnel BYTE-IDENTICAL before/after"
funnel BYTE-IDENTICAL before/after
```

PASS — byte-identical to the prereq baseline. No new route appeared; the app
transport is not Funneled (nothing routes to 3779). The pre-existing
`/csweet/webhook` route (my-c-sweet's, port 3778) is unchanged and unrelated.

## Failure triage

- Step 1 shows `0.0.0.0:<port>` → the daemon should have refused this bind —
  disable the flag (step 7) immediately and file it.
- Step 2 returns 404 on the fake path without a token → 401-precedes-404 has
  regressed (surface enumerable, ADR 0011) — roll back.
- Step 3 gets 202 but no events → check outbox parity with `?after=0`; events
  present there but not on SSE is a fan-out bug, absent in both means relay
  never ran (check the daemon journal).
- Step 4 non-zero exit → the failing check names the route; anything found
  broken live goes back through /verity:plan as a bug stage. **2026-07-28:
  exercised — the failures named the harness's reply window, not a daemon
  route; upstream issue #13 filed instead of a bug stage.**
- Step 7 re-enable does not bring routes back → confirm the token line
  survived the .env edit and check the journal for the fail-fast reason.
