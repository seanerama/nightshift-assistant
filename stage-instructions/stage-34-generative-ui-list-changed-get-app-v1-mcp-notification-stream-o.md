# Stage 34: Generative UI list_changed: GET /app/v1/mcp notification stream over registry mutations

- **Type:** feature
- **Depends on:** 31,32,33
- **Design:** docs/generative-ui-design.md · ADR 0015 (notification decision) ·
  contract: contracts/generative-ui.md (frozen v1)

## Objectives

`notifications/resources/list_changed` is actually emitted: `GET /app/v1/mcp`
becomes the streamable-HTTP spec's optional SSE stream for server-initiated
messages, and every registry mutation (register, activate, grant, revoke)
broadcasts the notification to all open streams. Best-effort by spec — zero
listeners is normal and mutation paths never block or fail on emission. The
certified stateless POST path is untouched.

## What to build

1. **GET handler** at `src/transport/app/server.ts:529` region: the current
   405 "POST only" arm grows a GET branch — same bearer gate (401 first),
   same `APP_TRANSPORT_ENABLED` gate. Per streamable-HTTP spec the stream
   requires `Accept: text/event-stream` (else 405/406 per spec). A long-lived
   SSE response with comment keep-alives, mirroring the discipline of
   `/app/v1/events`.
2. **Notification hub** (e.g. in `src/transport/app/mcp.ts`): a small
   broadcaster tracking open GET streams; `notifyResourcesChanged()` writes
   one SSE event carrying the JSON-RPC notification
   `{"jsonrpc":"2.0","method":"notifications/resources/list_changed"}` to
   each. Implementation latitude: the SDK's `sendResourceListChanged()` via a
   long-lived server+transport pair bound to GET streams, OR a hand-written
   SSE frame — the wire bytes are identical; choose the simpler that keeps
   the per-POST stateless posture (ADR 0012) intact.
3. **Capability declaration:** the per-POST SDK server declares
   `resources: { listChanged: true }` (mcp.ts `buildServer()`).
4. **Wire the four mutation points:** registry register / activate / grant /
   revoke each call `notifyResourcesChanged()` after commit. Registry-flag
   interplay: emission only matters when `NIGHTSHIFT_GENERATIVE_UI_ENABLED`
   is on (mutations can't happen otherwise); the GET stream itself follows
   the app-transport flag like the rest of `/app/v1/`.

## Interface contracts

- **Exposes:** the notification half of contracts/generative-ui.md §MCP —
  the server side of the client repo's future "live resource-list refresh".
- **Consumes:** contracts/app-ingress.md UNEDITED — the GET stream is part of
  the streamable-HTTP transport the pinned contract already names, not a new
  route shape (ADR 0015 records this reasoning). Stage 31–33 mutation paths.

## Testing requirements

- Integration: open an authenticated GET stream, run `ui install` /
  `ui activate` / `ui grant` / `ui revoke` — assert exactly one list_changed
  frame per mutation, valid JSON-RPC, on every open stream (test with two
  concurrent streams).
- Zero-listener path: mutations with no open stream succeed unchanged.
- Auth/flag: GET without bearer → 401; APP_TRANSPORT_ENABLED off → absent;
  wrong Accept → spec-correct rejection.
- Disconnect resilience: a client that vanishes mid-stream is pruned; the
  next mutation does not throw (write-after-end guarded).
- **Conformance harness green** (both flag states) — the certified POST
  behavior must be byte-identical; `initialize` now also advertises
  `listChanged`, confirm the harness accepts the additive capability.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature
      (gated by APP_TRANSPORT_ENABLED + Stage 31's flag as described — no
      third flag)
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (docs/smoke/: `curl -N` the GET stream, install a page, observe the
      frame)
- [ ] Additive migration only (no destructive schema change — expected: none)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
