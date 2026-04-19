#!/usr/bin/env bash
# Revert a single service to the image we tagged as :prev just before
# the last rollout. Safe to run manually at any time — it only touches
# the selected service, re-tags :prev → :latest, and recreates the
# container. DB + Redis containers are never touched.
#
# Usage: rollback.sh <service>
#   service: api | web

set -euo pipefail

cd "${REPO_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"

SERVICE="${1:?rollback.sh requires service (api|web)}"
case "$SERVICE" in
  api) IMAGE=qufox/api ;;
  web) IMAGE=qufox/web ;;
  *) echo "rollback.sh: unknown service '$SERVICE'" >&2; exit 2 ;;
esac

COMPOSE=(docker compose --env-file .env.prod -f docker-compose.prod.yml)

log() { printf '[rollback:%s] %s\n' "$SERVICE" "$*"; }

if ! docker image inspect "$IMAGE:prev" >/dev/null 2>&1; then
  log "no :prev tag — cannot auto-rollback. Manual recovery required." >&2
  exit 3
fi

log "tag $IMAGE:prev → :latest"
docker tag "$IMAGE:prev" "$IMAGE:latest"

log "recreate qufox-$SERVICE"
"${COMPOSE[@]}" up -d --no-deps "qufox-$SERVICE"

log "done — container now running previous image"
