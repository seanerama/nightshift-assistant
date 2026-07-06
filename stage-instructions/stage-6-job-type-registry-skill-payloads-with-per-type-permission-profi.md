# Stage 6: Job-type registry: skill payloads with per-type permission profiles

- **Type:** feature
- **Depends on:** 5

## Objectives

Make the factory's job types real: a registry mapping a job TYPE (story, study,
brief, app-build, generic) to how its worker runs — the skill/instruction
template it executes and the PERMISSION PROFILE its claude session gets
(operator decision 2026-07-06: per-job-type permissions, claude CLI throughout).
After this stage, "make me a bedtime story about X" from Webex becomes
`nightshift submit --type story ...` → a worker running `/story:start` with the
story profile → a finished story and a Webex notice.

## What to build

1. **Registry** (`src/jobs/types.ts`): a declarative table; each entry:
   `{ type, instructionTemplate(params), workdirStrategy, permissionArgs,
   extraEnv? }`. Initial entries:
   - `generic` — instruction passed through verbatim; near-zero permissions
     (Stage 4 behavior, the current default).
   - `story` → `/story:start` + params; `study` → `/sws:start`; `brief` →
     `/brief:run` — each with a project-dir workdir strategy
     (`~/projects/<slug>` style) and a WRITE-CAPABLE profile scoped to that dir.
   - `app-build` — the SDD build instruction; broadest profile (the old NSAF
     posture) — include but mark clearly experimental.
   Profiles are expressed as claude CLI args (`--allowedTools`/
   `--permission-mode` per the installed CLI's syntax — verify against
   `claude --help` on the host and document). Skills resolve via the host's
   `~/.claude` installation; the registry does NOT vendor them.
2. **Submit path** (additive per contract): `POST /api/v1/jobs` (and
   `nightshift submit --type story --params '<json>'`) accepts
   `{ type, params }`; the registry renders instruction/workdir/permissions;
   unknown type → 400 listing known types. The raw submit shape keeps working
   (maps to `generic`).
3. **Runner spawn** (`src/jobs/runner.ts`): worker spawn takes the registry
   entry's permissionArgs + extraEnv (still built ON TOP of `workerEnv()` —
   default-deny stands; extraEnv is an explicit per-type allow-list extension,
   e.g. the story pipeline's TTS/image keys by NAME, never wholesale).
4. **Session preamble** (Stage 5's capability preamble): extend with the type
   list and one-line usage each, so the assistant knows story/study/brief are
   dispatchable.
5. **Config**: `NIGHTSHIFT_TYPES_ENABLED` (kill-switch, default OFF — submit of
   a non-generic type rejects; generic unaffected). Per-type extra env names
   documented in `.env.example`.

## Interface contracts

- **Exposes:** the dispatchable type catalog (the assistant's real capabilities).
- **Consumes:** `contracts/control-api.md` (the additive `type+params` body it
  reserved), `contracts/job-lifecycle.md` (unchanged), `workerEnv()` as the
  security base. NO contract edits; no migration expected (type already a TEXT
  column).

## Testing requirements

- Registry rendering: each type → expected instruction/workdir/permission args;
  unknown type → 400 with the type list; params validation per type.
- Runner: spawned argv contains the type's permission args; extraEnv names
  present and NOTHING beyond allow-list + declared extras (extend the env-dump
  test per type); generic type remains byte-identical to Stage 5 workers.
- Kill-switch: types flag off → non-generic submit rejects, generic unaffected.
- CLI: `nightshift submit --type story --params ...` round-trip against a test
  app with the worker stub.
- **UI-smoke** (`docs/smoke/stage-6.md`): from Webex, request a real (short)
  story; confirm the worker runs the story skill with the story profile, the
  Webex finish notice arrives with the output location, and the artifacts exist.
  Include one permission-posture check: the story worker cannot read
  `~/apps/nightshift-assistant/.env` (scoped profile holds).

## Acceptance conditions

- [ ] Kill-switch: non-generic types dark unless `NIGHTSHIFT_TYPES_ENABLED=true`
- [ ] UI-smoke "observably-works" check authored (`docs/smoke/stage-6.md`)
- [ ] Additive migration only (none expected)
- [ ] Existing suite stays green; CI all-green
- [ ] `.env.example` covers every new env read; no secret material in repo
- [ ] Frozen contracts untouched; per-type env extension is name-explicit on top
      of workerEnv() (tested)

## Pipeline test: NO
