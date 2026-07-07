# Changelog

## 0.3.1

### Fixes
- prepend <appDir>/bin to the conversational session PATH (control-gated) (#14)

### Other
- Plan: Stage 7 bug spec — session PATH for the nightshift CLI

## 0.3.0

### Other
- [stage 6] Job-type registry: skill payloads with per-type permission profiles (#12)
- [stage 5] Control API + nightshift CLI: assistant session gets job/rotation/status tools (#11)
- Plan: control-api contract, ADR 0007, Stage 5+6 specs (capability wiring)
- Ship v0.2.0: STATUS — job runner live, stage-4 smoke passed

## 0.2.0

### Other
- [stage 4] Job runner: minimal-env worker sessions, reconciliation, sentinels, finish notices (#8)
- Plan: Stage 4 spec (job runner) + assessment
- Ship v0.1.1: STATUS — rotation live, stage-2 smoke passed

## 0.1.1

### Fixes
- pending-session detection is an explicit marker, not turns==0 (#6)

### Other
- Plan: Stage 3 bug spec — explicit pending-session marker

## 0.1.0

### Other
- [stage 2] Rotation ritual: daily summary, memory promotion, seeded fresh sessions (#4)
- Plan: Stage 2 spec (rotation ritual) + assessment
- Ship v0.0.1: STATUS runtime truth + ADR 0006 (Tailscale Funnel ingress)
- Ship: deploy.sh fixes — bootstrap into existing dir, drop invalid npm flag

## 0.0.1

### Other
- Ship: deploy.sh — bare-metal user-systemd deploy to the dev server, dark-safe
- [stage 1] Walking skeleton: verified Webex-to-Claude relay spine (#2)
- Plan: Stage 1 spec (walking skeleton) + assessment
- Architect: ADRs 0001-0005, frozen contracts v1, architecture + walking skeleton
- Initial commit — scaffolded by Verity
