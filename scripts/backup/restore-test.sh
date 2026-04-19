#!/usr/bin/env bash
# Restore the most recent Postgres dump into an ephemeral container and
# assert that at least one User row comes back. This is the single most
# important test in the whole backup system — an untested backup is
# Schrödinger's backup.
#
# Flow:
#   1. find newest $BACKUP_DIR/postgres/qufox-*.dump
#   2. start postgres:16-alpine with a disposable named container
#   3. wait for pg_isready
#   4. pg_restore into the fresh instance
#   5. SELECT COUNT(*) FROM "User" — nonzero is the success criterion
#   6. teardown container + volume
#
# Runs inside the qufox-backup container and talks to the host docker
# daemon via the shared docker.sock bind. Exits nonzero on any failure
# so cron alerts pick it up.

set -euo pipefail

: "${BACKUP_DIR:=/backups}"
RESTORE_CONTAINER="qufox-restore-test"
RESTORE_PASSWORD="restore-test-$(date +%s)"
RESTORE_NET="qufox-restore-test-net"

DUMP=$(ls -1 "$BACKUP_DIR"/postgres/qufox-*.dump 2>/dev/null | sort | tail -n 1 || true)
if [[ -z "$DUMP" ]]; then
  echo "[restore-test] no dump found under $BACKUP_DIR/postgres/" >&2
  exit 2
fi

log() { printf '[restore-test] %s\n' "$*"; }

log "using dump=$DUMP"

cleanup() {
  docker rm -f "$RESTORE_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$RESTORE_NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$RESTORE_NET" >/dev/null 2>&1 || true

log "start disposable postgres"
docker run --rm -d \
  --name "$RESTORE_CONTAINER" \
  --network "$RESTORE_NET" \
  -e POSTGRES_USER=qufox \
  -e POSTGRES_PASSWORD="$RESTORE_PASSWORD" \
  -e POSTGRES_DB=qufox \
  -v "$DUMP:/tmp/dump.pg:ro" \
  postgres:16-alpine >/dev/null

log "wait for pg_isready (max 60s)"
deadline=$(( $(date +%s) + 60 ))
while [[ $(date +%s) -lt $deadline ]]; do
  if docker exec "$RESTORE_CONTAINER" pg_isready -U qufox -d qufox >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

log "pg_restore"
docker exec -e PGPASSWORD="$RESTORE_PASSWORD" "$RESTORE_CONTAINER" \
  pg_restore -U qufox -d qufox --no-owner --no-privileges /tmp/dump.pg

log "SELECT COUNT(*) FROM \"User\""
count=$(docker exec -e PGPASSWORD="$RESTORE_PASSWORD" "$RESTORE_CONTAINER" \
  psql -U qufox -d qufox -At -c 'SELECT COUNT(*) FROM "User"')
if [[ -z "$count" || "$count" == "0" ]]; then
  log "FAIL: User table has $count rows in restored dump" >&2
  exit 1
fi
log "ok users=$count dump=$(basename "$DUMP")"
