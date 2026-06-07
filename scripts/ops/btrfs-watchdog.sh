#!/usr/bin/env bash
# btrfs metadata watchdog — pillar D backstop for the 2026-06 runaway, whose
# proximate cause was btrfs METADATA chunk exhaustion on /volume2 (not raw
# disk-full). Metadata ENOSPC happens when the metadata chunk is full AND
# there is no unallocated space left to carve a new metadata chunk — so this
# watches BOTH metadata-used% and device-unallocated.
#
# Tiers:
#   OK    : log a one-line status.
#   WARN  : metadata used >= WARN% (default 70) — reclaim now: docker image
#           prune + buildx cache prune + registry GC.
#   CRIT  : metadata used >= CRIT% (default 85) OR unallocated < MIN_UNALLOC
#           (default 2 GiB) — reclaim AND trip the deploy breaker so no new
#           build/deploy can pile on while space is tight. Requires a human
#           `reset-breaker.sh all` after confirming headroom.
#
# Intended to run periodically (cron / qufox-backup loop). Read-only unless a
# threshold is crossed. Exit code: 0 OK, 1 WARN acted, 2 CRIT acted.
#
# Usage: btrfs-watchdog.sh [mountpoint]   (default /volume2)
set -euo pipefail

MNT="${1:-/volume2}"
WARN_PCT="${QUFOX_BTRFS_WARN_PCT:-70}"
CRIT_PCT="${QUFOX_BTRFS_CRIT_PCT:-85}"
MIN_UNALLOC_GIB="${QUFOX_BTRFS_MIN_UNALLOC_GIB:-2}"
REPO="${REPO_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"

log() { printf '[btrfs-watchdog] %s\n' "$*"; }

# Convert a btrfs size token (e.g. 3.00GiB, 973.50MiB, 16.00KiB, 512.00B) to bytes.
to_bytes() {
  awk -v v="$1" 'BEGIN{
    if (match(v,/[0-9.]+/)) { num=substr(v,RSTART,RLENGTH) } else { print 0; exit }
    unit=substr(v,RSTART+RLENGTH)
    m=1
    if (unit ~ /^GiB/) m=1024*1024*1024
    else if (unit ~ /^MiB/) m=1024*1024
    else if (unit ~ /^KiB/) m=1024
    else if (unit ~ /^TiB/) m=1024*1024*1024*1024
    printf "%d", num*m
  }'
}

df_out="$(btrfs filesystem df "$MNT")"
meta_line="$(printf '%s\n' "$df_out" | grep -i '^Metadata')"
meta_total="$(printf '%s' "$meta_line" | sed -E 's/.*total=([0-9.]+[KMGT]iB).*/\1/')"
meta_used="$(printf '%s' "$meta_line" | sed -E 's/.*used=([0-9.]+[KMGT]iB).*/\1/')"
tot_b="$(to_bytes "$meta_total")"; used_b="$(to_bytes "$meta_used")"
pct=0; [ "$tot_b" -gt 0 ] && pct=$(( used_b * 100 / tot_b ))

unalloc="$(btrfs filesystem usage "$MNT" 2>/dev/null | awk -F: '/unallocated/{gsub(/ /,"",$2);print $2; exit}')"
unalloc_b="$(to_bytes "${unalloc:-0B}")"
min_unalloc_b=$(( MIN_UNALLOC_GIB * 1024 * 1024 * 1024 ))

status="metadata ${meta_used}/${meta_total} (${pct}%), unallocated ${unalloc:-?}"

reclaim() {
  log "reclaim: docker image prune + buildx cache prune + registry GC"
  docker image prune -f >/dev/null 2>&1 || true
  docker buildx prune --builder "${QUFOX_BUILDER:-qufox-builder}" \
    --keep-storage "${QUFOX_BUILD_CACHE_CAP:-8GB}" --force >/dev/null 2>&1 || true
  docker exec qufox-registry registry garbage-collect -m /etc/docker/registry/config.yml >/dev/null 2>&1 || true
}

if [ "$pct" -ge "$CRIT_PCT" ] || [ "$unalloc_b" -lt "$min_unalloc_b" ]; then
  log "CRIT: $status — reclaiming and tripping deploy breaker"
  reclaim
  # shellcheck source=../deploy/breaker.sh
  . "$REPO/scripts/deploy/breaker.sh"
  breaker::trip api "btrfs-metadata-critical"
  breaker::trip web "btrfs-metadata-critical"
  log "deploys HALTED — confirm headroom, then: scripts/deploy/reset-breaker.sh all"
  exit 2
elif [ "$pct" -ge "$WARN_PCT" ]; then
  log "WARN: $status — reclaiming"
  reclaim
  exit 1
else
  log "OK: $status"
  exit 0
fi
