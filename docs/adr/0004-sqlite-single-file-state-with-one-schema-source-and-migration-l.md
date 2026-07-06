# 0004. SQLite single-file state with one schema source and migration ladder

- **Status:** Accepted
- **Date:** 2026-07-06

## Context

The state to persist is small and single-writer: job records (worker sessions, PIDs,
status, retries), session metadata (current session id, rotation history), reminders,
and idea/project records. The predecessor also used SQLite but defined its schema in
six hand-copied places across two languages; the Node and Python definitions drifted
until fresh installs crashed the morning cron (remediation FIX-H6/ENH-03). It also had
no backups (ENH-09) and no transition rules (ENH-02).

## Decision

- **SQLite, one file**, accessed only by the core daemon (one language, one process —
  ADRs 0001/0002 make the six-copies problem structurally impossible).
- **One schema source of truth:** an ordered migration ladder (numbered SQL files)
  applied by the daemon at startup and by every test fixture. No `CREATE TABLE IF NOT
  EXISTS` scattered in code. A schema-version row records the applied head.
- **Guarded state transitions:** a single transition table (legal predecessor → successor
  status pairs) enforced by one helper through which every status write flows. Rejected
  transitions are logged, never silently applied. This is frozen as the job-lifecycle
  contract.
- **Scheduled backups from day one:** a systemd timer runs an online backup (SQLite
  backup API / `VACUUM INTO`) with retention, to a directory outside the primary; the
  walking skeleton's deploy includes it. Restore is documented in the recovery plan.

## Alternatives considered

- **Postgres** — already on the server for built apps, but brings a service dependency,
  credentials, and migration tooling for a single-user daemon whose state fits in
  kilobytes. Rejected for the core (built apps keep using it).
- **Flat JSON/YAML files** — simple, but job records need transactional guarded
  transitions under concurrent exits/polls; hand-rolling that on files recreates the
  race bugs this rebuild exists to kill.

## Consequences

- Backup/restore is file-copy simple; the backup timer ships with Stage 0, not as a
  someday item.
- If a second process ever needs state access, it goes through the daemon (or a new
  contract), never directly to the file.
- Schema changes are additive migrations; a breaking change is a new table + migration,
  mirroring the contracts-first rule.
