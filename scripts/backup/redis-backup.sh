#!/usr/bin/env bash
# Snapshot the production Redis via BGSAVE + copy of dump.rdb. Redis
# holds refresh-token revocation lists, rate-limit buckets, presence
# state, and the Socket.IO replay ring — none of it is the source of
# truth, but losing it on a disk crash would mean all logged-in users
# get booted. A daily snapshot is enough.
#
# Runs inside the qufox-backup container. Assumes:
#   - qufox-redis-prod is reachable on the `internal` network
#   - the Redis data volume is ALSO bind-mounted read-only into this
#     container at /redis-data so we can copy the rdb file out directly
#
# If the volume mount isn't present, falls back to --rdb dump via
# redis-cli (slower but works over the network).

set -euo pipefail

: "${BACKUP_DIR:=/backups}"
REDIS_HOST="${REDIS_HOST:-qufox-redis-prod}"
REDIS_PORT="${REDIS_PORT:-6379}"
DAILY_KEEP="${BACKUP_DAILY_KEEP:-14}"

OUT_DIR="$BACKUP_DIR/redis"
mkdir -p "$OUT_DIR"
chmod 0700 "$OUT_DIR" 2>/dev/null || true

STAMP=$(date -u +%Y-%m-%d)
OUT_FILE="$OUT_DIR/qufox-$STAMP.rdb.gz"

log() { printf '[redis-backup] %s\n' "$*"; }

log "BGSAVE on $REDIS_HOST:$REDIS_PORT"
redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" BGSAVE >/dev/null

# Wait for BGSAVE to finish — the command is async, but LASTSAVE ticks
# when the snapshot completes. Cap at 60s.
deadline=$(( $(date +%s) + 60 ))
initial=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" LASTSAVE)
while [[ $(date +%s) -lt $deadline ]]; do
  current=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" LASTSAVE)
  if [[ "$current" != "$initial" ]]; then break; fi
  sleep 1
done

if [[ -f /redis-data/dump.rdb ]]; then
  log "copy /redis-data/dump.rdb"
  gzip -c /redis-data/dump.rdb > "$OUT_FILE.tmp"
else
  log "/redis-data not mounted — using redis-cli --rdb fallback"
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --rdb "$OUT_FILE.rdb"
  gzip -f "$OUT_FILE.rdb"
  mv "$OUT_FILE.rdb.gz" "$OUT_FILE.tmp"
fi

mv "$OUT_FILE.tmp" "$OUT_FILE"
chmod 0600 "$OUT_FILE"

# shellcheck disable=SC2012
mapfile -t doomed < <(ls -1 "$OUT_DIR"/qufox-*.rdb.gz 2>/dev/null | sort | head -n "-$DAILY_KEEP" 2>/dev/null || true)
for f in "${doomed[@]:-}"; do
  [[ -z "$f" ]] && continue
  log "prune $(basename "$f")"
  rm -f "$f"
done

SIZE=$(stat -c %s "$OUT_FILE" 2>/dev/null || wc -c <"$OUT_FILE")
log "ok bytes=$SIZE file=$OUT_FILE"
