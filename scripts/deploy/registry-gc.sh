#!/usr/bin/env bash
# Trim old :sha-* tags from the local registry, then run the registry's blob
# garbage collector to reclaim space on /volume2. Pillar D housekeeping.
#
# Keeps: :latest, :prev, :buildcache, and the one :sha-<keep> passed in
# (the currently-deployed commit). Every OTHER :sha-* tag is deleted. We
# don't keep deep sha history in the registry — git has the history and a
# rebuild is cheap + isolated now, so fewer retained tags = fewer retained
# blobs = less btrfs pressure.
#
# Usage: registry-gc.sh [keep-sha-short]
#   keep-sha-short: a 7-char commit prefix to preserve (optional).
#
# Requires: jq, curl, and the qufox-registry container running.
set -euo pipefail

REGISTRY="${QUFOX_REGISTRY:-localhost:5050}"
KEEP_SHA="${1:-}"
REPOS=(qufox/api qufox/web)
ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'

log() { printf '[registry-gc] %s\n' "$*"; }

deleted=0
for repo in "${REPOS[@]}"; do
  tags="$(curl -s --max-time 10 "http://$REGISTRY/v2/$repo/tags/list" | jq -r '.tags[]?' 2>/dev/null || true)"
  [ -z "$tags" ] && continue
  while IFS= read -r tag; do
    case "$tag" in
      sha-*) ;;                         # only consider sha-* tags
      *) continue ;;
    esac
    [ -n "$KEEP_SHA" ] && [ "$tag" = "sha-$KEEP_SHA" ] && continue
    digest="$(curl -sI --max-time 10 -H "Accept: $ACCEPT" \
      "http://$REGISTRY/v2/$repo/manifests/$tag" \
      | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}')"
    if [ -n "$digest" ]; then
      if curl -s --max-time 10 -o /dev/null -w '%{http_code}' \
           -X DELETE "http://$REGISTRY/v2/$repo/manifests/$digest" | grep -q '^20'; then
        log "deleted $repo:$tag"
        deleted=$((deleted + 1))
      fi
    fi
  done <<< "$tags"
done

log "$deleted stale sha-tag(s) deleted; running blob garbage-collect"
# -m removes untagged manifests too. Safe: the cache/:latest/:prev/:sha-keep
# tags still reference their blobs, so only genuinely-unreferenced blobs go.
docker exec qufox-registry registry garbage-collect -m /etc/docker/registry/config.yml >/dev/null 2>&1 \
  || log "warn: registry garbage-collect failed (non-fatal)"
log "done"
