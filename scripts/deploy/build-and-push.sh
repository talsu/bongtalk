#!/usr/bin/env bash
# Build a qufox service image in the ISOLATED buildx builder and push it to
# the local registry. This REPLACES the old `docker compose build` that ran
# on the production docker daemon (see scripts/deploy/rollout.sh history).
#
# WHY (pillar A of the safe-deploy redesign)
#   The 2026-06 runaway exhausted btrfs metadata on /volume2 because each
#   production-daemon build turned every image layer into a host btrfs
#   subvolume under /volume2/@docker/btrfs/subvolumes, accumulating without
#   bound across repeated/failed builds. Building inside the docker-container
#   buildx builder keeps all that layer churn INSIDE the builder container
#   (measured: an isolated build adds 0 host subvolumes); the prod daemon
#   only ever pulls finished, deduplicated image layers.
#
# Usage:
#   build-and-push.sh <api|web> [sha]
#     sha defaults to `git rev-parse --short HEAD`, or "manual" if not a repo.
#
# Pushes:
#   $REGISTRY/qufox/<svc>:latest
#   $REGISTRY/qufox/<svc>:sha-<short>     (when sha is known)
# Build cache: registry-backed ($REGISTRY/qufox/<svc>:buildcache, mode=max)
#   — lives in the registry on /volume2 and is prunable as a unit.
#
# Env overrides: QUFOX_REGISTRY (default localhost:5050),
#   QUFOX_BUILDER (default qufox-builder), REPO_PATH (default: repo root).
#
# Runs `docker` directly — invoke as a user in the docker group or via sudo.
set -euo pipefail

REGISTRY="${QUFOX_REGISTRY:-localhost:5050}"
BUILDER="${QUFOX_BUILDER:-qufox-builder}"
REPO="${REPO_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$REPO"

SVC="${1:?build-and-push.sh requires service (api|web)}"
case "$SVC" in
  api) DOCKERFILE=apps/api/Dockerfile ;;
  web) DOCKERFILE=apps/web/Dockerfile ;;
  *) echo "build-and-push.sh: unknown service '$SVC' (expected api|web)" >&2; exit 2 ;;
esac

SHA="${2:-$(git rev-parse --short HEAD 2>/dev/null || echo manual)}"
IMAGE="$REGISTRY/qufox/$SVC"

log() { printf '[build-and-push:%s] %s\n' "$SVC" "$*"; }

# Fail fast with a clear message if the builder or registry isn't up — both
# are stood up by infra/registry/compose.yml + `docker buildx create
# --name qufox-builder` (see docs/ops/runbook-deploy.md).
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  log "buildx builder '$BUILDER' not found — create it first:" >&2
  log "  docker buildx create --name $BUILDER --driver docker-container --driver-opt network=host --bootstrap" >&2
  exit 3
fi
if ! curl -sf -o /dev/null --max-time 5 "http://${REGISTRY}/v2/"; then
  log "registry $REGISTRY not reachable — start it:" >&2
  log "  docker compose -p qufox-registry -f infra/registry/compose.yml up -d" >&2
  exit 3
fi

# Preserve the currently-published image as the rollback target BEFORE we
# overwrite :latest. Registry-only retag via imagetools — no host pull, so it
# stays off the prod graph driver. Skip for ad-hoc builds with QUFOX_SKIP_PREV=1.
if [ "${QUFOX_SKIP_PREV:-0}" != "1" ] && docker buildx imagetools inspect "$IMAGE:latest" >/dev/null 2>&1; then
  log "preserve rollback target: $IMAGE:latest -> :prev"
  docker buildx imagetools create --tag "$IMAGE:prev" "$IMAGE:latest" \
    || log "warn: could not set :prev (non-fatal)"
fi

TAGS=(--tag "$IMAGE:latest")
[ "$SHA" != "manual" ] && TAGS+=(--tag "$IMAGE:sha-$SHA")

log "build sha=$SHA image=$IMAGE builder=$BUILDER dockerfile=$DOCKERFILE"
# --provenance=false --sbom=false: produce a plain single-platform image
# manifest instead of an OCI image index with attestation manifests. We only
# build linux/amd64 for this NAS, so the index/attestations add nothing — and
# registry 2.8's garbage-collect does NOT correctly traverse OCI indexes, so
# an attestation-bearing image could have its referenced manifests deleted by
# GC (observed: imagetools/rollback then fail with "manifest not found").
# Plain manifests keep rollback (:prev retag) and registry GC safe.
docker buildx build \
  --builder "$BUILDER" \
  --file "$DOCKERFILE" \
  --provenance=false \
  --sbom=false \
  "${TAGS[@]}" \
  --cache-from "type=registry,ref=$IMAGE:buildcache" \
  --cache-to "type=registry,ref=$IMAGE:buildcache,mode=max" \
  --push \
  "$REPO"

log "done: $IMAGE:latest$([ "$SHA" != manual ] && echo " , $IMAGE:sha-$SHA")"

# Bound the builder's LOCAL cache so it can't grow without limit on /volume2.
# mode=max already exported the authoritative cache to the registry
# ($IMAGE:buildcache), so the next build still gets cache hits via
# --cache-from even after we trim the local copy here. Default cap 8 GB;
# override with QUFOX_BUILD_CACHE_CAP (e.g. "12GB"). This is the per-build
# half of pillar D; the btrfs watchdog is the periodic backstop.
CACHE_CAP="${QUFOX_BUILD_CACHE_CAP:-8GB}"
log "prune local build cache to <= $CACHE_CAP"
docker buildx prune --builder "$BUILDER" --keep-storage "$CACHE_CAP" --force >/dev/null 2>&1 \
  || log "warn: buildx prune failed (non-fatal)"
