# Stage 40: Hook ingress: deploy dark, Funnel the /hook/v1 path scope, certify live from off-tailnet

- **Type:** chore
- **Depends on:** 39
- **Design:** ADR 0018 · contract `contracts/hook-ingress.md` v1 ·
  smoke `docs/smoke/hook-ingress.md` (authored in stage 39) · Issue #89

## Objectives

Stage 39's hook door is live on the internet at
`https://3090-tuf.taile0ffc4.ts.net/hook/v1/messages`, proven from a caller
**off** the tailnet, with every other surface still unexposed. This is the
Release/Deploy Operator's stage (`/verity:ship`), modeled on stage 29.

## What to build

Operational steps on the prod host (`3090-tuf`, user systemd), in order:

1. **Deploy dark** — release containing stage 39 with `HOOK_INGRESS_ENABLED`
   unset. Verify: migration reached schema 11; `/hook/v1/messages` 404 on
   loopback; Webex + app transports unaffected (one Webex round-trip, app
   `/app/v1/health` 200 with token).
2. **Provision the credential** — generate `NIGHTSHIFT_HOOK_TOKEN` (≥ 32 random
   bytes, e.g. `openssl rand -hex 32`) into `~/apps/nightshift-assistant/.env`
   (mode 0600). Never echoed, logged, or committed. Hand it to the owner out of
   band (owner's choice of password manager).
3. **Enable on loopback** — set `HOOK_INGRESS_ENABLED=true`, restart, run the
   smoke's loopback checks (401 / 200 sync / 202+poll).
4. **Funnel the path scope** — `tailscale funnel --bg --set-path /hook/v1
   http://127.0.0.1:3777/hook/v1`. Do not touch the existing `/webhook` and
   `/csweet/webhook` scopes. Capture `tailscale funnel status` before/after.
5. **Certify from off-tailnet** — run `docs/smoke/hook-ingress.md` from a
   machine/network NOT on the tailnet — the owner's phone on cellular with
   Tailscale off, or any external shell. Do not add a CI workflow for this
   (`.github/` is out of bounds for stages). Must include: 401 without token, 200
   sync reply, 202 + poll, 429 after burst, and **404 at the edge for
   `/api/v1/status`, `/app/v1/health`, `/health`**.
6. **Long-wait check** — one request with `wait` = `HOOK_MAX_WAIT_SEC` against a
   deliberately slow prompt; record whether Funnel held the connection for the
   full wait. If the edge cuts it earlier, lower `HOOK_MAX_WAIT_SEC` in `.env`
   below the observed limit and record the number (the poll path is the
   guarantee either way).
7. **Record** — `.verity/deploy-access.md` (new Funnel scope, env var NAME +
   location only), STATUS.md via the operator, `docs/smoke/hook-ingress.md`
   results with date/version. Update the watchdog checklist: Funnel reachability
   now covers `/hook/v1` (401 expected unauthenticated) alongside `/webhook`.

Rollback: `tailscale funnel --set-path /hook/v1 off` + unset the flag + restart.
The table is additive and can remain.

## Interface contracts

- **Exposes:** `contracts/hook-ingress.md` v1 at the public URL above.
- **Consumes:** stage 39 build, ADR 0018/0006/0011, `.verity/deploy-access.md`.

## Testing requirements

- Full suite + CI green on the deployed revision (no code changes expected; any
  fix found live goes back through a bug stage, not into this chore).
- The live smoke in `docs/smoke/hook-ingress.md` executed and recorded, off-tailnet.

## Acceptance conditions

- [ ] Clear exit-state defined (what "done" means here): an off-tailnet caller
      gets a 200 sync reply from `/hook/v1/messages` with the token and 401
      without; `/api/v1/*`, `/app/v1/*`, `/health` 404 at the Funnel edge;
      Webex round-trip still works; token stored only in host `.env`;
      deploy-access + STATUS + smoke record updated; rollback command recorded
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
