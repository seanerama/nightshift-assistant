# Stage 19: reMarkable PUSH: nightshift remarkable <path> uploads a doc to the tablet via cloud

- **Type:** feature
- **Depends on:** none

## Objectives

Give the assistant a first-class capability to **push a document to the user's reMarkable
tablet**. The Webex session can run `nightshift remarkable <path>` and the file lands in
the tablet's `/Inbox` folder via the reMarkable **cloud API** (works with the tablet
off-network — it syncs down on the tablet's next sync). This is the "assistant → tablet"
half of the two-way reMarkable bridge. Ships **dark**.

## What to build

Mirror the existing **`deliver`** capability almost verbatim (`src/transport/deliver.ts`
+ its route/CLI/preamble/app wiring) — this is the sanctioned additive pattern on
`control-api` v1 (Stages 10/11 precedent).

- **`src/transport/remarkable.ts`** — new module, modeled on `deliver.ts`:
  - `createRemarkablePusher({ enabled, folder, rmapiBin, allowedRoots, run })` returning a
    `push(path)` function.
  - **Path-confine** the input to the same allowed roots `deliver` uses (`~/projects`,
    app `jobs/`, `logs/`); reject anything outside (no `..`, no symlink escape).
  - Hand the confined path to a **reMarkable transport seam** (default impl shells
    `rmapi put <path> <folder>`); the exec is injected (`run`) so tests never hit the cloud.
    Keep the transport isolated so it's swappable (rmapi-js / native) later.
- **`src/transport/api.ts`** — new `POST /api/v1/remarkable` route (loopback, behind the
  existing `NIGHTSHIFT_CONTROL_ENABLED` + bearer gates), 1:1 with the capability.
- **`bin/nightshift`** — new `remarkable <path>` subcommand hitting that route (mirror the
  `deliver` subcommand shape).
- **`src/session/manager.ts`** — one preamble line telling the session it can
  `nightshift remarkable <path>` to send a doc to the tablet (only when enabled). Keep the
  `Bash(nightshift *)` allow-rule unchanged (no new tool, no MCP for the session).
- **`src/app.ts`** — wire `createRemarkablePusher(...)` from config, like `createDeliverer`.
- **`src/config.ts` + `.env.example`** — add, documented:
  - `NIGHTSHIFT_REMARKABLE_ENABLED` (default **false** — dark-launch kill-switch),
  - `NIGHTSHIFT_REMARKABLE_FOLDER` (default `/Inbox`),
  - `RMAPI_BIN` (path to the `rmapi` binary on the host; default `rmapi`).
  Config discipline: read nothing undocumented.

## Interface contracts

- **Consumes (frozen — must not break):** `control-api.md` v1 (new route + CLI subcommand
  are **additive**, the explicitly-sanctioned class), `assistant-session.md` (preamble
  injection only; one-session invariant untouched).
- **Exposes:** the `remarkable` capability. **No new contract; no frozen contract reopened.**
- The reMarkable **device token / `rmapi` config is a daemon-only host secret** — never in
  `workerEnv`, never in git. rmapi + its config are provisioned on the host (ops/ship step,
  below), not shipped in the repo.

## Testing requirements

- Unit (no cloud, no real rmapi): `push()` **refuses** a path outside allowed roots;
  builds the correct `rmapi put <path> <folder>` argv (injected `run` captures it);
  when `enabled=false` the capability is absent / refuses (dark by default).
- Route test: `POST /api/v1/remarkable` honors the control gates + bearer; disabled → 404/403.
- **UI-smoke (operator, post-deploy):** with the flag on, `nightshift remarkable <a.pdf>`
  → the PDF appears in `/Inbox` on the tablet after sync. Document it in the smoke asset.

## Acceptance conditions

- [ ] Kill-switch `NIGHTSHIFT_REMARKABLE_ENABLED` (default **OFF**); disabled = no route, no capability.
- [ ] UI-smoke authored: `nightshift remarkable <pdf>` → doc in tablet `/Inbox`.
- [ ] Additive only — `deliver`/session/control-api behavior unchanged; no frozen contract reopened; no schema change.
- [ ] Path-confinement enforced (no escape outside allowed roots); rmapi/token stay daemon-only.
- [ ] Existing suite stays green; CI all-green.

## Ops / deploy prerequisite (handled at ship, not in this stage's code)

- `rmapi` (ddvk fork, v3/tortoise-capable) installed on the NSAF host; `~/.config/rmapi/rmapi.conf`
  seeded with the reMarkable **device token** (mode 0600). Record the secret **location** in
  `.verity/deploy-access.md` + `STATUS.md` (name + path only, never the value).

## Pipeline test: NO
