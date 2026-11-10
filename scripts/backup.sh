#!/bin/sh
# Consistent SQLite snapshot via the online backup API; publish only after success.
# Host cron (root): 0 3 * * * /opt/baton/scripts/backup.sh
set -eu

DB="${BATON_DB_PATH:-/opt/baton/data/baton.db}"
DIR="${BATON_BACKUP_DIR:-/opt/baton/backups}"
KEEP_DAYS="${BATON_BACKUP_KEEP_DAYS:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$DIR/baton-$STAMP.db"
TEMP="$TARGET.tmp"

[ -f "$DB" ] || { echo "backup: database not found: $DB" >&2; exit 1; }
[ -d "$DIR" ] || { echo "backup: backup directory not found: $DIR" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "backup: sqlite3 is required" >&2; exit 1; }

umask 077
rm -f "$TEMP"
sqlite3 "$DB" ".backup '$TEMP'"
[ -s "$TEMP" ] || { echo "backup: empty snapshot" >&2; rm -f "$TEMP"; exit 1; }
chmod 600 "$TEMP"
mv "$TEMP" "$TARGET"

# Delete only this application's backups older than the retention window.
find "$DIR" -maxdepth 1 -type f -name 'baton-*.db' -mtime "+$KEEP_DAYS" -delete

echo "backup: wrote $TARGET"
