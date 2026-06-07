#!/usr/bin/env bash
# Pull-based rollout of a single production service with health-gated
# auto-rollback. The image was already built + pushed to the local registry
# by scripts/deploy/build-and-push.sh (and the previous :latest preserved as
# :prev there). This script NEVER builds — keeping the production daemon
# build-free is pillar A of the safe-deploy redesign (no per-layer btrfs
# subvolume churn = the 2026-06 runaway cannot recur).
#
# Flow:
#   1. docker compose pull <svc>     (fetch the new :latest from the registry)
#   2. docker compose up -d --no-deps <svc>
#   3. health-wait.sh                (up to 120s against /readyz or /)
#   4. on failure: rollback.sh <svc> (restore :prev), exit 1
#
# Usage: rollout.sh <service>   (service: api | web)
set -euo pipefail

cd "${REPO_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"

SERVICE="${1:?rollout.sh requires service (api|web)}"
REGISTRY="${QUFOX_REGISTRY:-localhost:5050}"

case "$SERVICE" in
  api) HEALTH_URL="${API_HEALTH_URL:-https://qufox.com/api/readyz}" ;;
  web) HEALTH_URL="${WEB_HEALTH_URL:-https://qufox.com/}" ;;
  *) echo "rollout.sh: unknown service '$SERVICE' (expected api|web)" >&2; exit 2 ;;
esac

COMPOSE=(docker compose -p qufox --env-file .env.prod -f docker-compose.prod.yml)

log() { printf '[rollout:%s] %s\n' "$SERVICE" "$*"; }

# --- 1. pull the freshly-built image from the local registry ------------
log "pull $REGISTRY/qufox/$SERVICE:latest"
"${COMPOSE[@]}" pull "qufox-$SERVICE"

# --- 2. recreate the container with the new image -----------------------
log "up -d --no-deps qufox-$SERVICE"
"${COMPOSE[@]}" up -d --no-deps "qufox-$SERVICE"

# --- 3. health gate -----------------------------------------------------
if bash "$(dirname "$0")/health-wait.sh" "$HEALTH_URL" "${HEALTH_MAX_SECONDS:-120}" "${HEALTH_INTERVAL:-2}"; then
  log "healthy — deploy retained"
  exit 0
fi

# --- 4. auto-rollback ---------------------------------------------------
log "FAILED health check — rolling back to :prev" >&2
bash "$(dirname "$0")/rollback.sh" "$SERVICE"
exit 1
