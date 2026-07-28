# 0011. App transport binds tailnet-private with bearer auth; 401 precedes 404; no Funnel exposure

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

ADR 0006 chose Tailscale Funnel for the ONE public route (`/webhook`). The app
surface is different: the Nightshift Client runs on the owner's phone, which is
already on the tailnet. Public exposure would add an internet-reachable
authenticated surface for zero reach benefit. The control API (ADR 0007) set
the pattern: private bind + per-install bearer token, fail closed.

## Decision

- The app routes bind **loopback + the tailnet interface only**. No Funnel, no
  cloudflared. The existing `/webhook` Funnel scope is untouched.
- Bearer token from **`NIGHTSHIFT_APP_TOKEN`** — generated at deploy, stored in
  the host `.env`, same pattern as `NIGHTSHIFT_API_TOKEN`. A distinct token, so
  the phone credential can be rotated without touching the CLI/control plane.
- **Auth on every route; 401 precedes 404.** An unauthenticated probe learns
  nothing about which paths exist — the surface is not enumerable without a
  token. Token unset → all app routes refuse (fail closed).
- `personId` must equal the configured owner id or the request is 403 — the
  same single-owner authorization invariant as webex-ingress, on the new door.
- Dark by default: `APP_TRANSPORT_ENABLED` (default off) gates route
  registration entirely — flag off = routes absent, not 403.

## Alternatives considered

- **Funnel a path scope like `/webhook`** (per ADR 0006's pattern) — rejected:
  the client never needs internet reach; every public byte is attack surface.
- **Tailscale identity headers / `tailscale serve` auth instead of a bearer
  token** — rejected: ties auth to tailscaled behavior and breaks the harness's
  plain-HTTP `--token` model; defense-in-depth wants the token even on a
  private interface (a stray tailnet device is not the owner's phone).
- **Reuse `NIGHTSHIFT_API_TOKEN`** — rejected: one credential across two
  surfaces means one rotation blast radius; tokens are cheap.

## Consequences

- The phone must be on the tailnet to reach the assistant — accepted; the
  client is owner-only by design.
- Deploy verification includes `ss -tlnp` confirming the bind and a curl smoke
  from another tailnet machine (401 without token, manifest with).
- Deployment target is unchanged: `nsaf-dev-server` per ADR 0003 and
  `.verity/deploy-access.md`; this feature adds one env var and no new
  exposure to that record.
