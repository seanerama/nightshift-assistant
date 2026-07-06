# Contract: control-api

- **Status:** frozen v1
- **Owner:** transport module (endpoints) + `bin/nightshift` (the CLI consumer)

## Exposes

**Loopback-only HTTP API** under `/api/v1/` (never tunneled; the funnel exposes
`/webhook` only). JSON in/out. Every endpoint returns `{ ok: true, ... }` or
`{ ok: false, error: string }` with an appropriate status code.

- `POST /api/v1/jobs` — body: the job-lifecycle contract's submit shape
  (+ Stage 6 additively accepts `{ type: <registered-type>, params: {...} }`).
  → `{ ok, job: JobRecord }`
- `GET /api/v1/jobs?status=<s>` → `{ ok, jobs: JobRecord[] }`
- `GET /api/v1/jobs/<id>` → `{ ok, job }` (404 when unknown)
- `POST /api/v1/jobs/<id>/kill` → `{ ok, job }`
- `POST /api/v1/session/rotate` — body `{ reason?: 'manual' }` → `{ ok, rotation: RotationRecord }`
- `GET /api/v1/status` → `{ ok, version, uptimeSec, session: { id, turns },
  jobs: { queued, running, succeeded, failed, killed }, rotation: { enabled },
  jobsEnabled }`

**`nightshift` CLI** (committed at `bin/nightshift`, on PATH via npm bin or
symlink): the 1:1 human/agent face of the API — `nightshift submit|jobs|job|kill|
rotate|status`. Text output for humans and models; `--json` for raw API JSON.
Exit code 0 on `ok:true`, 1 otherwise. The conversational session invokes tools
ONLY through this CLI (`Bash(nightshift *)` allowed at spawn).

## Consumes

- `App.jobs` (job-lifecycle contract) and `App.sessions.rotate` (assistant-session
  contract) — the API is a thin authenticated door to them, no business logic.
- Auth: a per-install bearer token (`NIGHTSHIFT_API_TOKEN`, generated at deploy,
  stored in `.env`) required on every `/api/v1/` request — defense-in-depth so a
  worker or stray local process cannot drive the daemon even on loopback. The CLI
  reads it from the environment/env file. Fail closed when unset.

## Schema / wire

- Loopback bind is inherited from ADR 0001; `/api/v1/*` returns 404 through any
  public exposure by construction (funnel path-scoping) and 401 without the token.
- Kill-switch: `/api/v1/*` (and the CLI) refuse when `NIGHTSHIFT_CONTROL_ENABLED`
  is not `true` (dark by default).
- JobRecord/RotationRecord shapes are the frozen job-lifecycle and
  assistant-session contracts — this contract adds no fields to them.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
