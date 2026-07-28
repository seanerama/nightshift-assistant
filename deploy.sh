#!/usr/bin/env bash
# Deploy Nightshift Assistant to the dev server (.verity/deploy-access.md).
# Run from the workstation: ./deploy.sh [tag]     (defaults to latest v* tag)
#
# Bare-metal systemd deploy per ADR 0003, adapted to USER units (no passwordless
# sudo on the host; loginctl Linger=yes so user units survive logout/reboot).
# Secrets: ~/apps/nightshift-assistant/.env on the host — created BY HAND once
# (see .env.example); this script never reads or prints secret values. ONE
# write exception (stage 29): on first app-transport enable it GENERATES
# NIGHTSHIFT_APP_TOKEN into that .env — openssl rand -hex 32, the same
# provisioning .env.example prescribes for NIGHTSHIFT_API_TOKEN — appended,
# never displayed, never read back.
#
# The deploy is DARK-SAFE: if NIGHTSHIFT_ENABLED=true is not set in the host
# .env, the unit is installed but NOT started (the daemon's kill-switch would
# refuse anyway). Flipping it on is a deliberate operator step. The app
# transport (stage 29) follows the same discipline: this script NEVER sets
# APP_TRANSPORT_ENABLED — the flag stays off unless the operator puts
# APP_TRANSPORT_ENABLED=true in the host .env.
set -euo pipefail

HOST="smahoney@100.110.222.42"
APP_DIR="apps/nightshift-assistant"
REPO_URL="https://github.com/seanerama/nightshift-assistant.git"
TAG="${1:-$(git describe --tags --abbrev=0)}"

echo "deploying $TAG to $HOST:$APP_DIR"

ssh "$HOST" APP_DIR="$APP_DIR" REPO_URL="$REPO_URL" TAG="$TAG" 'bash -s' <<'REMOTE'
set -euo pipefail
cd ~
if [ ! -d "$APP_DIR/.git" ]; then
  # Bootstrap in place — the dir may already exist (e.g. holding .env).
  mkdir -p "$APP_DIR"
  git -C "$APP_DIR" init -q
  git -C "$APP_DIR" remote add origin "$REPO_URL"
fi
cd "$APP_DIR"
git fetch --tags origin
git checkout --detach "refs/tags/$TAG"
npm ci >/dev/null
npm run build

# Stage 5: the nightshift CLI on PATH — the conversational session's Bash tool
# and the operator's ops command are the same committed script. Symlink (not
# copy) so the CLI resolves the app dir's .env for its token/port fallback.
mkdir -p ~/.local/bin
ln -sfn "$HOME/$APP_DIR/bin/nightshift" ~/.local/bin/nightshift

# Install USER units adapted from the committed system units:
#  - drop User= (implicit for user units)
#  - WantedBy=default.target (user session equivalent of multi-user.target)
#  - EnvironmentFile + WorkingDirectory at the real app dir
mkdir -p ~/.config/systemd/user
for unit in systemd/*.service systemd/*.timer; do
  name="$(basename "$unit")"
  sed -e '/^User=/d' \
      -e "s|^WantedBy=multi-user.target|WantedBy=default.target|" \
      -e "s|^WantedBy=timers.target|WantedBy=timers.target|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$HOME/$APP_DIR|" \
      -e "s|^EnvironmentFile=.*|EnvironmentFile=$HOME/$APP_DIR/.env|" \
      "$unit" > ~/.config/systemd/user/"$name"
done
systemctl --user daemon-reload
systemctl --user enable nightshift-backup.timer >/dev/null 2>&1 || true

# Stage 29: app-transport deploy config (contracts/app-ingress.md, ADR 0011).
# Runs BEFORE the restart below so a first-enable token exists when the daemon
# comes up. Dark-safe: only reacts to APP_TRANSPORT_ENABLED=true already in
# the host .env — never flips the flag. On first enable (flag true, no
# non-empty NIGHTSHIFT_APP_TOKEN line) it generates the bearer token exactly
# the way NIGHTSHIFT_API_TOKEN is provisioned (openssl rand -hex 32, per
# .env.example) and appends it to .env without printing it; systemd
# EnvironmentFile last-line-wins makes the append authoritative. All three
# app vars (APP_TRANSPORT_ENABLED / NIGHTSHIFT_APP_BIND / NIGHTSHIFT_APP_PORT)
# reach the daemon through the units' existing EnvironmentFile=.env — no unit
# change. NO Funnel/cloudflared change of any kind: the app transport binds
# only what NIGHTSHIFT_APP_BIND lists (loopback + tailnet IP; the daemon
# refuses 0.0.0.0), and `tailscale funnel status` must stay /webhook-only.
if [ -f .env ] && grep -q '^APP_TRANSPORT_ENABLED=true' .env; then
  if ! grep -q '^NIGHTSHIFT_APP_TOKEN=..*' .env; then
    printf 'NIGHTSHIFT_APP_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
    echo "app transport: NIGHTSHIFT_APP_TOKEN generated on first enable (value not shown)"
  fi
  app_bind="$(sed -n 's/^NIGHTSHIFT_APP_BIND=//p' .env | tail -1)"
  app_port="$(sed -n 's/^NIGHTSHIFT_APP_PORT=//p' .env | tail -1)"
  echo "app transport: ENABLED in .env (bind ${app_bind:-127.0.0.1 [default]}, port ${app_port:-3778 [default]})"
else
  echo "app transport: dark (no APP_TRANSPORT_ENABLED=true in .env; flag is operator-set only)"
fi

if [ -f .env ] && grep -q '^NIGHTSHIFT_ENABLED=true' .env; then
  systemctl --user enable nightshift-assistant.service >/dev/null 2>&1 || true
  systemctl --user restart nightshift-assistant.service
  systemctl --user start nightshift-backup.timer || true
  sleep 2
  systemctl --user is-active nightshift-assistant.service
  echo "deployed $TAG — service ACTIVE"
else
  echo "deployed $TAG — DARK (no .env with NIGHTSHIFT_ENABLED=true; unit installed, not started)"
fi
REMOTE
