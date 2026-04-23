#!/usr/bin/env bash
# task-036-E: weekly base backup. Sunday 02:00 from qufox-backup cron.
# Keeps the last 4 runs under /volume3/qufox-data/backups/pg-base/YYYY-MM-DD/
# and emits a plain-text run record next to each. The WAL archive at
# /volume3/qufox-data/backups/pg-wal lets us PITR from the latest
# base-backup up to any moment since.

set -euo pipefail

BACKUP_ROOT=${BACKUP_ROOT:-/volume3/qufox-data/backups/pg-base}
RETAIN=${RETAIN:-4}
CONTAINER=${CONTAINER:-qufox-postgres-prod}
LOG_FILE=${LOG_FILE:-/volume3/qufox-data/backups/pg-base/runs.log}

mkdir -p "$BACKUP_ROOT"
STAMP=$(date -u +'%Y-%m-%dT%H%M%SZ')
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"

echo "[pg-base-backup] $STAMP start" | tee -a "$LOG_FILE"

docker exec -u postgres "$CONTAINER" pg_basebackup \
  -D /tmp/base-$STAMP \
  -Ft -z \
  -P \
  -X fetch \
  -U qufox
docker cp "$CONTAINER:/tmp/base-$STAMP/." "$DEST/"
docker exec -u postgres "$CONTAINER" rm -rf "/tmp/base-$STAMP"

size=$(du -sh "$DEST" | awk '{print $1}')
echo "[pg-base-backup] $STAMP done — $DEST ($size)" | tee -a "$LOG_FILE"

# Retain last N.
cd "$BACKUP_ROOT"
ls -1d 20* 2>/dev/null | sort -r | tail -n +$((RETAIN + 1)) | while read -r old; do
  echo "[pg-base-backup] pruning $old" | tee -a "$LOG_FILE"
  rm -rf "$old"
done
