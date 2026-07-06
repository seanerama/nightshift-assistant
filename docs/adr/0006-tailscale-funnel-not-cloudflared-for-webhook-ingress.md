# 0006. Tailscale Funnel (not cloudflared) for webhook ingress

- **Status:** Accepted
- **Date:** 2026-07-06

## Context

ADR 0003 assumed a cloudflared tunnel for exposing `/webhook`. At first deploy,
reality on the host differed: no cloudflared is installed; the existing Cloudflare
tunnel credentials (`CF_TUNNEL_*` in the old NSAF env) belong to a tunnel terminating
on the Coolify server, and the available `CF_DNS_TOKEN` cannot create new tunnels
(DNS-scoped; verified by API call). The host's ngrok agent was tried first and
**stole the free-tier static domain from the old NSAF flask tunnel**, breaking the
old bot's webhook for ~2 minutes until rolled back — the two systems cannot share
that agent during the parallel run. The host is already on Tailscale.

## Decision

**Tailscale Funnel**, path-scoped: `tailscale funnel --set-path /webhook
http://127.0.0.1:3777/webhook`, public at
`https://3090-tuf.taile0ffc4.ts.net/webhook`.

- Exposes ONLY the `/webhook` path — stricter than either tunnel option, and exactly
  the ADR 0003 exposure goal (`/health` returns 404 from the edge; verified).
- Stable hostname across restarts — eliminates the tunnel-URL-rotation failure class
  (old NSAF FIX-M6) by construction.
- No new accounts, credentials, or daemons: the tailscaled already on the host
  carries it. One-time setup: Funnel enabled on the tailnet (operator, browser) and
  `tailscale set --operator=smahoney` (operator, sudo once).

## Alternatives considered

- **cloudflared (per ADR 0003)** — needs a new tunnel; existing credentials cannot
  create one, and a connector replica of the Coolify tunnel would round-robin traffic
  to the wrong host. Viable later with a properly-scoped CF API token; not worth the
  account surgery for the skeleton.
- **Second ngrok tunnel on the existing agent** — tried; free tier binds every tunnel
  to the single static domain, hijacking the old NSAF webhook. Rejected on evidence.
- **Direct exposure / port-forward** — violates the loopback-bind rule; rejected.

## Consequences

- Ingress depends on Tailscale's Funnel service (TLS terminates at Tailscale's edge).
  Acceptable for a single-operator personal system already committed to Tailscale.
- The funnel config lives in the host's tailscaled state, not this repo — recorded in
  `.verity/deploy-access.md` and STATUS.md; the watchdog stage should check funnel
  reachability alongside daemon liveness.
- If the tailnet name changes, the webhook URL changes: re-register the Webex webhook
  (one API call).
