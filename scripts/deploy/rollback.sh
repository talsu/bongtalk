#!/usr/bin/env bash
# Revert a single service to the image preserved as :prev in the local
# registry just before the last rollout (build-and-push.sh sets :prev).
# Safe to run manually at any time — it only retags :prev -> :latest in the
# registry and recreates the selected container. DB/Redis are never touched.
#
# Registry-only retag via `docker buildx imagetools create` (no host pull
# until the compose pull below) keeps everything off the prod build path.
#
# Usage: rollback.sh <service>   (service: api | web)
set -euo pipefail

cd "${REPO_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"

SERVICE="${1:?rollback.sh requires service (api|web)}"
REGISTRY="${QUFOX_REGISTRY:-localhost:5050}"
case "$SERVICE" in
  api|web) IMAGE="$REGISTRY/qufox/$SERVICE" ;;
  *) echo "rollback.sh: unknown service '$SERVICE'" >&2; exit 2 ;;
esac

COMPOSE=(docker compose -p qufox --env-file .env.prod -f docker-compose.prod.yml)

log() { printf '[rollback:%s] %s\n' "$SERVICE" "$*"; }

if ! docker buildx imagetools inspect "$IMAGE:prev" >/dev/null 2>&1; then
  log "no :prev tag in registry — cannot auto-rollback. Manual recovery required." >&2
  exit 3
fi

log "retag $IMAGE:prev -> :latest (registry)"
docker buildx imagetools create --tag "$IMAGE:latest" "$IMAGE:prev"

log "pull + recreate qufox-$SERVICE"
"${COMPOSE[@]}" pull "qufox-$SERVICE"
"${COMPOSE[@]}" up -d --no-deps "qufox-$SERVICE"

log "done — container now running previous image"
