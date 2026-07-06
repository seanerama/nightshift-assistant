#!/bin/sh
# SQLite online backup via VACUUM INTO, with simple retention (ADR 0004).
# Invoked by systemd/nightshift-backup.service (timer: nightshift-backup.timer).
# Uses the app's own better-sqlite3 (no sqlite3 CLI required on the host); run
# from the app directory (the service sets WorkingDirectory).
# Env (all optional):
#   NIGHTSHIFT_DB_PATH     source database (default data/nightshift.db)
#   NIGHTSHIFT_BACKUP_DIR  destination directory (default ~/backups/nightshift)
#   NIGHTSHIFT_BACKUP_KEEP how many newest backups to keep (default 14)
set -eu

DB="${NIGHTSHIFT_DB_PATH:-data/nightshift.db}"
DEST="${NIGHTSHIFT_BACKUP_DIR:-$HOME/backups/nightshift}"
KEEP="${NIGHTSHIFT_BACKUP_KEEP:-14}"

if [ ! -f "$DB" ]; then
  echo "backup: source db not found: $DB" >&2
  exit 1
fi

mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/nightshift-$STAMP.db"

BACKUP_SRC="$DB" BACKUP_OUT="$OUT" node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.env.BACKUP_SRC, { readonly: true });
  db.prepare("VACUUM INTO ?").run(process.env.BACKUP_OUT);
  db.close();
'
echo "backup: wrote $OUT"

# Retention: keep the newest $KEEP backups.
ls -1t "$DEST"/nightshift-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
  rm -- "$old"
  echo "backup: pruned $old"
done
