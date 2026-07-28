# Stage 29: App transport deploy dark and certify live on the tailnet

- **Type:** feature
- **Depends on:** 26,28

## Objectives

The full surface, already CI-certified since Stage 24, goes live on the
production daemon and is certified THERE: harness exit 0 against the real
tailnet endpoint, dual-run with Webex proven, release truth recorded. This is
an ops-heavy stage; the code diff should be near-zero.

## What to build

1. **Deploy config (`deploy.sh` + host `.env` + `systemd/` env plumbing):**
   generate `NIGHTSHIFT_APP_TOKEN` at deploy (same pattern as
   `NIGHTSHIFT_API_TOKEN`); set `APP_TRANSPORT_ENABLED=true`;
   `NIGHTSHIFT_APP_BIND=127.0.0.1,<tailnet-ip>` (host tailnet IP —
   `100.110.222.42` per `.verity/deploy-access.md`). **No Funnel/cloudflared
   change of any kind** — `tailscale funnel status` must show `/webhook` only,
   before and after (ADR 0011 / ADR 0006).
2. **Resolve the env-path discrepancy** flagged 2026-07-24 in
   `.verity/deploy-access.md` (`~/nightshift-assistant/.env` vs
   `~/apps/nightshift-assistant/.env`): confirm on the host, correct the stale
   record, note the truth in STATUS.md.
3. **Live verification, in order (all evidence into `docs/smoke/stage-29.md`):**
   a. `ss -tlnp` on the host: app port listening on `127.0.0.1` and the
      tailnet IP ONLY — no `0.0.0.0`, no public interface.
   b. From ANOTHER tailnet machine: curl without token → 401 (on a real and a
      fake path — enumeration check); with token → manifest listing exactly
      `["chat","files","mcp-tools","mcp-apps-ui"]`.
   c. SSE client from that machine observes a REAL reply: POST a message → 202
      → `ack` then `reply` arrive on `/app/v1/events` with contiguous ids.
   d. `npx agent-app-conformance http://<tailnet-ip>:<port> --token <t>
      --person-id <owner>` from the tailnet machine → **exit 0**.
   e. **Webex round-trip:** send a message through Webex and receive the
      normal reply — dual-run proven, not assumed.
   f. MCP Inspector checks per `docs/smoke/stage-27.md` and resource read per
      `docs/smoke/stage-28.md`.
4. **STATUS.md release truth:** version, harness-green-on-prod statement with
   date, the Funnel-unchanged check, and — explicitly — that the owner's
   phone-to-agent Stage-0 exit (chat + kill a real job from the Nightshift
   Client on the device) is **PENDING, owner-performed, not claimed**.

**Deliberately NOT in this stage:** feature code changes (anything found broken
live goes back through /verity:plan as a bug stage), push notifications, token
streaming, Webex removal, watchdog changes, client-repo work, outbox pruning.

## Interface contracts

- **Exposes:** the live, certified `/app/v1/` surface on the tailnet — the
  endpoint the Nightshift Client will be pointed at.
- **Consumes:** `contracts/app-ingress.md` v1 (certified by the harness on
  prod); `.verity/deploy-access.md` (target: `nsaf-dev-server`, ADR 0003);
  `contracts/webex-ingress.md` v1 (dual-run must be demonstrated intact).

## Testing requirements

- CI: unchanged — the Stage 24 conformance job already gates the merge.
- The live checklist above IS this stage's test; every step's output (redacting
  the token) is pasted into `docs/smoke/stage-29.md`. A step that cannot be
  demonstrated is a stage that is not done — no "should work" entries
  (state can't lie).

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag: documented rollback = set
      `APP_TRANSPORT_ENABLED=false` + restart; verified once during smoke
      (routes vanish, Webex unaffected), then re-enabled
- [ ] UI-smoke "observably-works" check executed live: 3a–3f all evidenced in
      `docs/smoke/stage-29.md`
- [ ] Additive migration only (no destructive schema change)
- [ ] Funnel scope byte-identical before/after; `ss -tlnp` evidence committed
- [ ] STATUS.md records release truth; owner Stage-0 exit marked PENDING, not
      claimed
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
