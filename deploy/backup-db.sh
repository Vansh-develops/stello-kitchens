#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Encrypted local Postgres snapshot for Stello Kitchens.
#   pg_dump (inside the postgres container) → gzip → optional AES-256 → retention
#
# This is the "same-host now, off-host later" tier: snapshots land in ./backups/
# under the app folder. For real disaster recovery, sync BACKUP_DIR to off-host
# storage (S3/R2/rsync to another box) — a same-host backup does NOT survive a
# VPS/disk loss. See the companion restore-db.sh.
#
# Schedule via cron, e.g. daily at 02:30:
#   30 2 * * *  /webserver/vansh/stello-kitchen/deploy/backup-db.sh >> \
#               /webserver/vansh/stello-kitchen/backups/backup.log 2>&1
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"          # stello-kitchen root
COMPOSE=(docker compose -f "$HERE/deploy/docker-compose.prod.yml" --env-file "$HERE/deploy/.env")
BACKUP_DIR="${BACKUP_DIR:-$HERE/backups}"
RETENTION="${BACKUP_RETENTION:-14}"                              # keep newest N snapshots

# Load POSTGRES_* and (optional) BACKUP_PASSPHRASE from the deploy env.
set -a; . "$HERE/deploy/.env"; set +a
PGUSER="${POSTGRES_USER:-stello}"
PGDB="${POSTGRES_DB:-stello}"

mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/stello-$TS.sql.gz"

echo "[backup $(date -Is)] dumping database '$PGDB' ..."
"${COMPOSE[@]}" exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" postgres \
  pg_dump -U "$PGUSER" -d "$PGDB" --no-owner --clean --if-exists \
  | gzip -9 > "$OUT"

# Encrypt at rest if a passphrase is configured (recommended).
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:${BACKUP_PASSPHRASE}" -in "$OUT" -out "$OUT.enc"
  rm -f "$OUT"; OUT="$OUT.enc"
  echo "[backup] encrypted (AES-256)."
else
  echo "[backup] WARNING: BACKUP_PASSPHRASE not set — snapshot stored unencrypted."
fi
chmod 600 "$OUT"
echo "[backup] wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: delete everything older than the newest $RETENTION snapshots.
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/stello-*.sql.gz* 2>/dev/null | tail -n +$((RETENTION + 1)) || true)
for f in "${OLD[@]:-}"; do [ -n "$f" ] && { rm -f "$f"; echo "[backup] pruned $(basename "$f")"; }; done

echo "[backup] done — $(ls -1 "$BACKUP_DIR"/stello-*.sql.gz* 2>/dev/null | wc -l) snapshots retained."
