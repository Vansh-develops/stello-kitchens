#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Restore a Stello Kitchens snapshot produced by backup-db.sh.
#   Usage: ./deploy/restore-db.sh backups/stello-YYYYMMDD-HHMMSS.sql.gz[.enc]
#
# WARNING: this OVERWRITES the current database (the dump is --clean --if-exists).
# Test it on a throwaway DB first; an untested backup is not a backup.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$HERE/deploy/docker-compose.prod.yml" --env-file "$HERE/deploy/.env")
FILE="${1:?usage: restore-db.sh <backup-file.sql.gz[.enc]>}"

set -a; . "$HERE/deploy/.env"; set +a
PGUSER="${POSTGRES_USER:-stello}"
PGDB="${POSTGRES_DB:-stello}"

tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
case "$FILE" in
  *.enc) openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE required to decrypt}" -in "$FILE" | gunzip > "$tmp" ;;
  *.gz)  gunzip -c "$FILE" > "$tmp" ;;
  *)     cp "$FILE" "$tmp" ;;
esac

echo "About to restore '$FILE' into database '$PGDB' — this OVERWRITES current data."
echo "Ctrl-C now to abort; continuing in 5s..."; sleep 5
"${COMPOSE[@]}" exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" postgres \
  psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" < "$tmp"
echo "[restore] complete."
