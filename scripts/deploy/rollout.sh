#!/usr/bin/env bash
# Swap a single production service to a fresh image with rollback on
# health failure. Mirrors the conventions of scripts/prod-reload.sh
# (same compose file + env file) so operators can still reach for that
# script as an escape hatch.
#
# Flow:
#   1. tag qufox/<svc>:latest → :prev   (rollback target)
#   2. docker compose build <svc>        (produces new :latest)
#   3. tag :latest → :sha-<short>        (history)
#   4. docker compose up -d --no-deps <svc>
#   5. health-wait.sh                    (up to 120s)
#   6. on failure: tag :prev → :latest + recreate, exit 1
#
# Usage: rollout.sh <service>
#   service: api | web

set -euo pipefail

cd "${REPO_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"

SERVICE="${1:?rollout.sh requires service (api|web)}"
SHA_SHORT="${DEPLOY_SHA:-unknown}"
SHA_SHORT="${SHA_SHORT:0:7}"

case "$SERVICE" in
  api) CONTAINER=qufox-api IMAGE=qufox/api HEALTH_URL="${API_HEALTH_URL:-https://qufox.com/api/readyz}" ;;
  web) CONTAINER=qufox-web IMAGE=qufox/web HEALTH_URL="${WEB_HEALTH_URL:-https://qufox.com/}" ;;
  *) echo "rollout.sh: unknown service '$SERVICE'" >&2; exit 2 ;;
esac

COMPOSE=(docker compose --env-file .env.prod -f docker-compose.prod.yml)

log() { printf '[rollout:%s] %s\n' "$SERVICE" "$*"; }

# --- 1. preserve rollback target ----------------------------------------
if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then
  log "tag $IMAGE:latest → :prev"
  docker tag "$IMAGE:latest" "$IMAGE:prev"
else
  log "no existing :latest to preserve — first deploy?"
fi

# --- 2. build fresh image ----------------------------------------------
log "build (sha=$SHA_SHORT)"
"${COMPOSE[@]}" build "qufox-$SERVICE"

# --- 3. record sha tag for future rollback ------------------------------
if [[ "$SHA_SHORT" != "unknown" ]]; then
  log "tag $IMAGE:latest → :sha-$SHA_SHORT"
  docker tag "$IMAGE:latest" "$IMAGE:sha-$SHA_SHORT"
fi

# --- 4. recreate container ---------------------------------------------
log "up -d --no-deps qufox-$SERVICE"
"${COMPOSE[@]}" up -d --no-deps "qufox-$SERVICE"

# --- 5. health check with retry ----------------------------------------
if bash "$(dirname "$0")/health-wait.sh" "$HEALTH_URL" "${HEALTH_MAX_SECONDS:-120}" "${HEALTH_INTERVAL:-2}"; then
  log "healthy — deploy retained"
  exit 0
fi

# --- 6. rollback on failure --------------------------------------------
log "FAILED health check — rolling back to :prev" >&2
bash "$(dirname "$0")/rollback.sh" "$SERVICE"
exit 1
