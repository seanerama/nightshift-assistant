# Stage 32: Generative UI versions and rollback: next-version install, ui show/activate, read any @vN

- **Type:** feature
- **Depends on:** 31
- **Design:** docs/generative-ui-design.md · ADR 0015 ·
  contract: contracts/generative-ui.md (frozen v1)

## Objectives

Iteration and rollback: installing under an existing name assigns the next
version and makes it active; prior versions are retained, readable, and
re-activatable. `resources/list` advertises exactly the active version per
name; `resources/read` serves any registered `@vN`. Versions are never
deleted or edited — a change is the next version, rollback is re-activation.

## What to build

1. **Registry module:** next-version install (validate → `MAX(version)+1` →
   insert → flip `active` in one transaction: exactly one active per name,
   enforced), `versions(name)`, `activate(name, version)`, `get(name,
   version)` with HTML.
2. **Control doors** (additive on Stage 31's set, per the frozen contract):
   `GET /api/v1/ui/resources/<name>` (all versions, HTML omitted),
   `GET /api/v1/ui/resources/<name>/<version>` (with `html`),
   `POST /api/v1/ui/resources/<name>/activate` body `{ version }` (404
   unknown name/version). Flag off → 404, as everywhere.
3. **CLI verbs:** `ui show <name> [<version>]`, `ui activate <name>
   <version>`.
4. **MCP mapping:** `resources/list` shows the ACTIVE `@vN` per name;
   `resources/read` accepts any registered exact `@vN` uri (active or not) —
   a listed client can always read what it saw listed, and rollback needs the
   old bytes.

## Interface contracts

- **Exposes:** the version/rollback subset of contracts/generative-ui.md;
  the one-active-per-name invariant that Stages 33–35 assume.
- **Consumes:** Stage 31's registry module, validator, doors, and flag —
  extended additively, not reshaped. contracts/control-api.md and
  contracts/app-ingress.md remain unedited.

## Testing requirements

- Round-trip integration test: install `tracker` v1 → install again → v2
  active, v1 retained → `ui activate tracker 1` → v1 active again; at each
  step assert `resources/list` shows exactly the active uri and
  `resources/read` returns correct bytes for BOTH `@v1` and `@v2`.
- Transactionality: a failed install (invalid HTML) against an existing name
  leaves the active pointer and version count untouched.
- 404s: activate unknown version, show unknown name.
- Invariant test at the SQL level: never two active rows per name.
- Conformance harness green in both flag states.

## Acceptance conditions

- [ ] Kill-switch / dark-launch flag (default OFF) for this net-new feature
      (Stage 31's flag gates everything here — no second flag)
- [ ] UI-smoke "observably-works" check authored for any user-facing surface
      (extend the docs/smoke/ asset: the v1→v2→rollback list/read sequence)
- [ ] Additive migration only (no destructive schema change — expected: NO new
      migration; 0009 already carries the schema)
- [ ] Existing suite stays green; CI all-green

## Pipeline test: NO
