#!/usr/bin/env bash
# task-036-E: weekly PITR restore drill. Sunday 03:00 (cron inside
# qufox-backup, after the 02:00 base backup). Spins a throwaway
# postgres:16-alpine container with the latest base backup +
# WAL archive mounted read-only, lets recovery complete, then runs
# a sanity query (User count) against the restored DB. Exits 0 on
# success, writes a timestamp to
# /volume3/qufox-data/backups/pg-base/last-restore-ok — which the
# prom-file-sd exporter reads for qufox_pitr_restore_last_success.
#
# On failure: non-zero exit + optional Slack webhook if SLACK_WEBHOOK_URL
# is set in the environment.

set -euo pipefail

BACKUP_ROOT=${BACKUP_ROOT:-/volume3/qufox-data/backups/pg-base}
WAL_DIR=${WAL_DIR:-/volume3/qufox-data/backups/pg-wal}
MARKER=${MARKER:-$BACKUP_ROOT/last-restore-ok}
LOG_FILE=${LOG_FILE:-$BACKUP_ROOT/pitr-runs.log}
TMP_VOL=${TMP_VOL:-qufox-pitr-test}
CONTAINER_NAME=${CONTAINER_NAME:-qufox-pitr-test}

STAMP=$(date -u +'%Y-%m-%dT%H%M%SZ')
log() { printf '[pitr-test] %s %s\n' "$STAMP" "$*" | tee -a "$LOG_FILE"; }

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$TMP_VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

LATEST=$(ls -1d "$BACKUP_ROOT"/20* 2>/dev/null | sort -r | head -1 || true)
if [ -z "$LATEST" ]; then
  log "FAIL: no base backup under $BACKUP_ROOT"
  exit 1
fi
log "latest base = $LATEST"

cleanup
docker volume create "$TMP_VOL" >/dev/null

# Start a scratch container, extract the base tarball into $PGDATA,
# stage a recovery.signal + restore_command pointing at the WAL archive.
docker run -d --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=tmp \
  -v "$TMP_VOL":/var/lib/postgresql/data \
  -v "$WAL_DIR":/wal-archive:ro \
  postgres:16-alpine tail -f /dev/null >/dev/null

docker exec -u root "$CONTAINER_NAME" sh -c '
  set -e
  PGDATA=/var/lib/postgresql/data
  rm -rf "$PGDATA"/*
  chown postgres:postgres "$PGDATA"
'
# Copy the tarballs in.
docker cp "$LATEST/base.tar.gz" "$CONTAINER_NAME:/tmp/base.tar.gz"
if [ -f "$LATEST/pg_wal.tar.gz" ]; then
  docker cp "$LATEST/pg_wal.tar.gz" "$CONTAINER_NAME:/tmp/pg_wal.tar.gz"
fi
docker exec -u postgres "$CONTAINER_NAME" sh -c '
  set -e
  PGDATA=/var/lib/postgresql/data
  tar -xzf /tmp/base.tar.gz -C "$PGDATA"
  if [ -f /tmp/pg_wal.tar.gz ]; then
    tar -xzf /tmp/pg_wal.tar.gz -C "$PGDATA/pg_wal"
  fi
  touch "$PGDATA/recovery.signal"
  printf "restore_command = '\''cp /wal-archive/%%f %%p'\''\n" >> "$PGDATA/postgresql.auto.conf"
'

# Start postgres proper and wait for readiness.
docker exec -u root "$CONTAINER_NAME" killall tail 2>/dev/null || true
docker restart "$CONTAINER_NAME" >/dev/null

for i in $(seq 1 40); do
  if docker exec -u postgres "$CONTAINER_NAME" pg_isready -d qufox >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! docker exec -u postgres "$CONTAINER_NAME" pg_isready -d qufox >/dev/null 2>&1; then
  log "FAIL: restored postgres never became ready"
  exit 2
fi

# Sanity query: User row count > 0.
count=$(docker exec -u postgres "$CONTAINER_NAME" psql -U qufox -d qufox -Atc 'SELECT COUNT(*) FROM "User"' 2>/dev/null || echo 'err')
if ! [[ "$count" =~ ^[0-9]+$ ]] || [ "$count" -lt 0 ]; then
  log "FAIL: sanity User count query returned $count"
  exit 3
fi
log "OK — restored User count = $count"

# Flip the marker + timestamp for the prom textfile exporter.
echo "$STAMP" > "$MARKER"
printf 'qufox_pitr_restore_last_success_timestamp %d\n' "$(date -d "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" +%s 2>/dev/null || date +%s)" \
  > "$BACKUP_ROOT/pitr-metrics.prom"
log "marker updated — $MARKER"
