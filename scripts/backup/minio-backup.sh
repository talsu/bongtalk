#!/usr/bin/env bash
# Incremental snapshot of the MinIO data directory via rsync
# --link-dest (hardlinks to the previous snapshot for unchanged
# objects, real copies for new/modified ones). Runs from the
# qufox-backup container; path layout mirrors the postgres + redis
# jobs under $BACKUP_DIR/minio/<YYYY-MM-DDTHH>/.
#
# MinIO on this NAS is a single instance with SHR/RAID-level redundancy
# at the volume layer, so this snapshot is primarily for "I deleted
# the wrong file" recovery + the weekly restore-test. It lives on the
# SAME physical disk as the live data — off-site copy is a separate
# ops task.

set -euo pipefail

: "${BACKUP_DIR:=/backups}"
# The MinIO data dir is bind-mounted read-only into qufox-backup at
# /minio-data (see compose.deploy.yml). Not a network fetch — rsync
# works directly.
SOURCE_DIR="${MINIO_SOURCE_DIR:-/minio-data}"
SNAP_KEEP="${MINIO_SNAPSHOT_KEEP:-14}"

OUT_ROOT="$BACKUP_DIR/minio"
mkdir -p "$OUT_ROOT"
chmod 0700 "$OUT_ROOT" 2>/dev/null || true

log() { printf '[minio-backup] %s\n' "$*"; }

if [[ ! -d "$SOURCE_DIR" ]]; then
  log "FAIL: MinIO source dir not mounted at $SOURCE_DIR" >&2
  log "Expected qufox-backup compose to bind-mount /volume3/qufox-data/minio:ro" >&2
  exit 2
fi

STAMP=$(date -u +%Y-%m-%dT%H)
SNAP="$OUT_ROOT/$STAMP"

# If the most recent snapshot is this hour's, leave it alone (hourly
# cron won't double-run, but a manual re-invocation would otherwise
# overwrite a still-warm snapshot).
if [[ -d "$SNAP" ]]; then
  log "snapshot already exists for this hour: $SNAP (no-op)"
  exit 0
fi

# Find the previous snapshot to --link-dest from. Sorted listing by
# name works because timestamps are YYYY-MM-DDTHH.
# shellcheck disable=SC2012
PREV=$(ls -1 "$OUT_ROOT" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}$' | sort | tail -n 1 || true)

RSYNC_ARGS=(-a --delete)
if [[ -n "$PREV" ]]; then
  log "link-dest: $OUT_ROOT/$PREV"
  RSYNC_ARGS+=(--link-dest "$OUT_ROOT/$PREV")
fi

log "rsync $SOURCE_DIR/ → $SNAP"
rsync "${RSYNC_ARGS[@]}" "$SOURCE_DIR/" "$SNAP/"
chmod 0700 "$SNAP"

# Retention: keep $SNAP_KEEP newest hourly snapshots, drop the rest.
# Since snapshots hardlink, the cost of older snapshots is only the
# delta; pruning is cheap.
# shellcheck disable=SC2012
mapfile -t stale < <(ls -1 "$OUT_ROOT" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}$' | sort | head -n "-$SNAP_KEEP" 2>/dev/null || true)
for d in "${stale[@]:-}"; do
  [[ -z "$d" ]] && continue
  log "prune $d"
  rm -rf "$OUT_ROOT/$d"
done

SIZE_USED=$(du -sh "$OUT_ROOT" 2>/dev/null | awk '{print $1}')
log "ok snapshot=$SNAP backups_total_size=$SIZE_USED"
