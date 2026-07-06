# 0003. Run under systemd on the dev server; deploy over SSH

- **Status:** Accepted
- **Date:** 2026-07-06

## Context

NSAF's operational chaos had a specific root: run-mode ambiguity. The runbook described
systemd services while the real system ran via `nohup`, the referenced health/backup
scripts never existed, and nothing prevented a second orchestrator instance from
double-building against the shared database (remediation FIX-H9). The new daemon needs
one true run mode, chosen once. The deployment host is the existing dev server
(`ssh smahoney@100.110.222.42`), which already carries the Claude CLI, the `skills/`
monorepo, project directories, and the per-app Postgres infrastructure.

## Decision

- **Host:** the existing dev server, reached over SSH (Tailscale address). Recorded in
  the user-global deployment catalog (`~/.verity/deployment-methods.md`); per-app access
  details in `.verity/deploy-access.md` (gitignored, locations only, never secrets).
- **Run mode: systemd, bare-metal.** The unit file lives in this repo and is installed
  by the deploy script. `Restart=on-failure` gives crash recovery; systemd's single
  activation is the single-instance guard the old core lacked. The watchdog runs as a
  systemd timer unit.
- **Deploy:** `deploy.sh` (built later by /verity:ship) does: push → SSH pull on the
  server → install deps → run migrations → `systemctl restart`. No container for the
  core.
- **Network exposure:** daemon binds loopback; a cloudflared tunnel exposes only the
  webhook path publicly. Everything else is reachable only on the host / tailnet.

## Alternatives considered

- **Docker on the same server** — cleaner isolation, but the daemon's whole purpose is
  spawning `claude` CLI sessions against the host's skills and project directories;
  containerizing means mounting most of the host in anyway. Rejected as isolation
  theater for this workload.
- **Managed PaaS (Coolify/Render/Fly)** — wrong shape: the daemon is stateful, spawns
  local processes, and owns local files. (Coolify remains where *built apps* get
  promoted; that's a capability, not this daemon's home.)
- **Keep nohup** — the failure mode this ADR exists to kill.

## Consequences

- Recovery runbook and reality match by construction: the unit file in the repo *is*
  the run mode.
- Deploys require the server reachable over SSH; there is no blue/green — a restart
  drops in-flight webhook requests for a few seconds (Webex retries; acceptable for
  one user).
- The old NSAF core keeps running via its own mechanism during the parallel transition;
  distinct service name + ports + a second Webex bot identity keep them independent.
