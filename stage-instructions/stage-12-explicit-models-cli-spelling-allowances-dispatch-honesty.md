# Stage 12: Explicit models, CLI-spelling allowances, dispatch honesty

- **Type:** feature
- **Depends on:** 11

## Objectives

Three operator-approved fixes from live use (issue #22 + its comment):
models chosen deliberately instead of inherited from host config (currently a
silent Opus 4.7 for everything); the session's own CLI allowed in every spelling
it reaches for; and a hard honesty rule about dispatch claims.

## What to build

1. **Conversational model**: `NIGHTSHIFT_MODEL` (default `claude-sonnet-5`)
   passed as `--model` at the conversational spawn site. Config-validated
   non-empty string; documented in `.env.example`.
2. **Per-type worker models**: registry entries gain `model` (story/study/brief/
   app-build → `claude-opus-4-8`; generic → `claude-sonnet-5`), appended to
   worker spawn args alongside permissionArgs (mind the variadic-flag ordering
   rule from Stage 6). Update the pinned argv tests deliberately — the byte-
   identical guarantees move to "with the new defaults".
3. **Tool-rule spellings**: NIGHTSHIFT_TOOL_RULE becomes the three-spelling set
   `Bash(nightshift *)`, `Bash(bin/nightshift *)`, `Bash(./bin/nightshift *)`
   (single --allowedTools value, space-separated per the verified CLI syntax).
   The model keeps reaching for visible paths; all three are OUR binary.
4. **Preamble honesty rule**: "Never state a job was submitted/dispatched unless
   the CLI returned a job id — quote the id. If a command is denied, say so
   plainly and stop."

## Interface contracts

No contract changes; no migration. Registry/config/preamble only.

## Testing requirements

- Conversational argv contains `--model <NIGHTSHIFT_MODEL>`; worker argv contains
  the per-type model; ordering safe w.r.t. `-p` (extend the Stage 6 order test).
- Tool rule: argv's --allowedTools value contains all three spellings.
- Preamble contains the honesty rule + all three spellings guidance updated
  (bare `nightshift` still preferred).
- Config: default sonnet-5; garbage rejected; existing flag-off spawn (control
  disabled) byte-identical EXCEPT the model flag (which applies regardless of
  control — re-pin deliberately, document in the test).
- UI-smoke (docs/smoke/stage-12.md): on-host `ps` shows --model on the live
  conversational session after a message; a dispatched job's worker shows its
  type's model; bot dispatch via `bin/nightshift` spelling now succeeds.

## Acceptance conditions

- [ ] Kill-switch n/a — model default applies always (documented); dark-launch
      not required for arg-level config (existing suite re-pinned deliberately)
- [ ] UI-smoke authored (docs/smoke/stage-12.md)
- [ ] No migration; frozen contracts untouched
- [ ] Existing suite stays green; CI all-green
- [ ] `.env.example` covers every new env read

## Pipeline test: NO
