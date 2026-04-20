#!/usr/bin/env bash
# pg_dump the production Postgres into a rotated snapshot directory.
# Designed to run inside the qufox-backup container on a cron schedule,
# but can be invoked manually on the host too (so the runbook only has
# one command to teach).
#
# Layout:
#   $BACKUP_DIR/postgres/qufox-YYYY-MM-DD.dump      (daily)
#   $BACKUP_DIR/postgres/weekly/qufox-YYYY-MM-DD.dump  (copied on Sunday)

set -euo pipefail

: "${POSTGRES_PASSWORD:?}"
: "${BACKUP_DIR:=/backups}"
PG_HOST="${PG_HOST:-qufox-postgres-prod}"
PG_USER="${PG_USER:-qufox}"
PG_DB="${PG_DB:-qufox}"
DAILY_KEEP="${BACKUP_DAILY_KEEP:-14}"
WEEKLY_KEEP="${BACKUP_WEEKLY_KEEP:-8}"

OUT_DIR="$BACKUP_DIR/postgres"
WEEKLY_DIR="$OUT_DIR/weekly"
mkdir -p "$OUT_DIR" "$WEEKLY_DIR"
chmod 0700 "$BACKUP_DIR" "$OUT_DIR" "$WEEKLY_DIR" 2>/dev/null || true

STAMP=$(date -u +%Y-%m-%d)
DAY_OF_WEEK=$(date -u +%u)   # 7 = Sunday
OUT_FILE="$OUT_DIR/qufox-$STAMP.dump"

log() { printf '[db-backup] %s\n' "$*"; }

# task-014-A (task-009-low-1 closure): clean up the half-written `.tmp`
# on ENOSPC / SIGTERM / unclean exit so the next scheduled run doesn't
# reject on a stale leftover that pg_dump won't overwrite. Fires on
# both error and clean exit; the post-mv path is a no-op (`.tmp` gone).
trap 'rm -f "$OUT_FILE.tmp"' EXIT

log "pg_dump → $OUT_FILE"
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  --host "$PG_HOST" --username "$PG_USER" --dbname "$PG_DB" \
  --format=custom --compress=9 --no-owner --no-privileges \
  --file "$OUT_FILE.tmp"
# Atomic move so a partial dump is never picked up by restore tests.
mv "$OUT_FILE.tmp" "$OUT_FILE"
chmod 0600 "$OUT_FILE"

if [[ "$DAY_OF_WEEK" == "7" ]]; then
  log "sunday — copy to weekly/"
  cp -p "$OUT_FILE" "$WEEKLY_DIR/qufox-$STAMP.dump"
fi

# --- rotation: keep N daily, M weekly (FIFO by name, which sorts by date)
prune() {
  local dir="$1" keep="$2"
  # `ls -1` is intentional here — names are YYYY-MM-DD sortable.
  # shellcheck disable=SC2012
  mapfile -t doomed < <(ls -1 "$dir"/qufox-*.dump 2>/dev/null | sort | head -n "-$keep" 2>/dev/null || true)
  for f in "${doomed[@]:-}"; do
    [[ -z "$f" ]] && continue
    log "prune $(basename "$f")"
    rm -f "$f"
  done
}

prune "$OUT_DIR" "$DAILY_KEEP"
prune "$WEEKLY_DIR" "$WEEKLY_KEEP"

SIZE=$(stat -c %s "$OUT_FILE" 2>/dev/null || wc -c <"$OUT_FILE")
log "ok bytes=$SIZE file=$OUT_FILE"
