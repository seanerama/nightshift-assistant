# Stage 28: App UI resource: jobs dashboard ui-nightshift-jobs-v1 per ui-bridge

- **Type:** feature
- **Depends on:** 27

## Objectives

The first rendered surface the client can host: `ui://nightshift/jobs@v1`, a
single-file HTML jobs dashboard served as an MCP resource, driving Stage 27's
tools through the ui-bridge postMessage protocol. This is the `mcp-apps-ui`
capability.

## What to build

1. **MCP resource `ui://nightshift/jobs@v1`** registered on the Stage 27 MCP
   server: one self-contained HTML file (inline CSS/JS, no external fetches)
   living in the repo (e.g. `src/transport/app/resources/jobs-v1.html`) and
   served as the resource body.
2. **Tool declaration:** the resource declares
   `_meta["ui/tools"]: ["jobs_list", "jobs_kill", "jobs_submit"]`. This
   convention lives in the CLIENT repo
   (`nightshift-client/contracts/ui-bridge.md`), not the contract repo — the
   resource file HEADER must cite ui-bridge.md so the provenance is recorded
   (architect handoff / ADR 0012). A resource that skips the declaration gets
   an empty allowlist in the app; the declaration is not optional.
3. **Dashboard behavior:** job list, status filter
   (queued/running/succeeded/failed/killed — the frozen JobRecord statuses,
   contracts/control-api.md), kill button per job, submit form. All data access
   via postMessage JSON-RPC tool calls to the three declared tools — nothing
   else.
4. **ui-bridge constraints (hard):** no network (no fetch/XHR/WebSocket/
   external src), no storage (no localStorage/sessionStorage/IndexedDB/
   cookies), postMessage JSON-RPC only, and **render degradable** — the file
   must render something sensible (static shell + "tools unavailable" state)
   when no bridge answers, so a plain webview or Inspector preview isn't a
   blank page.
5. **Manifest:** add `"mcp-apps-ui"` when the harness resource checks pass.

**Deliberately NOT in this stage:** any client-repo work (the app rendering
this is out of scope), generative UI, more resources, more tools, streaming
updates (the dashboard refreshes by re-calling `jobs_list`).

## Interface contracts

- **Exposes:** the `ui://nightshift/jobs@v1` resource. `@v1` in the uri is the
  version seam — a breaking dashboard change is a NEW `@v2` resource, never an
  edit (ADR 0012).
- **Consumes:** Stage 27's tool names (`jobs_list`, `jobs_kill`,
  `jobs_submit` — the allowlist references them by exact name);
  `nightshift-client/contracts/ui-bridge.md` (external convention, cited in
  the file header); `contracts/app-ingress.md` v1.

## Testing requirements

- Static conformance test on the HTML file: header cites ui-bridge.md;
  `_meta["ui/tools"]` exactly the three names; no `fetch(`/`XMLHttpRequest`/
  `WebSocket`/`localStorage`/`sessionStorage`/`indexedDB`/`document.cookie`/
  external `src=`/`href=` (beyond inline/data), single file. Crude greps are
  acceptable and honest — say so in the test comment; the behavioral proof is
  Inspector + the client.
- MCP integration test: resources/list includes the uri; resources/read
  returns the HTML with the `_meta` declaration intact.
- CI conformance job passes the harness resource checks.
- **Post-deploy smoke asset — `docs/smoke/stage-28.md`** (runs at Stage 29):
  Inspector over the tailnet reads the resource; opening the HTML standalone
  in a browser shows the degradable shell, not a blank page.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) still gates everything
- [ ] UI-smoke "observably-works" check authored (`docs/smoke/stage-28.md`)
- [ ] Additive migration only (no destructive schema change)
- [ ] ui-bridge constraints enforced by test; provenance header present
- [ ] `"mcp-apps-ui"` declared only with harness resource checks green
- [ ] Existing suite stays green; CI all-green including conformance

## Pipeline test: NO
