#!/usr/bin/env bash
# Deploy Nightshift Assistant to the dev server (.verity/deploy-access.md).
# Run from the workstation: ./deploy.sh [tag]     (defaults to latest v* tag)
#
# Bare-metal systemd deploy per ADR 0003, adapted to USER units (no passwordless
# sudo on the host; loginctl Linger=yes so user units survive logout/reboot).
# Secrets: ~/apps/nightshift-assistant/.env on the host — created BY HAND once
# (see .env.example); this script never writes or reads secret values.
#
# The deploy is DARK-SAFE: if NIGHTSHIFT_ENABLED=true is not set in the host
# .env, the unit is installed but NOT started (the daemon's kill-switch would
# refuse anyway). Flipping it on is a deliberate operator step.
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
