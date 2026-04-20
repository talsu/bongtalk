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

COMPOSE=(docker compose -p qufox --env-file .env.prod -f docker-compose.prod.yml)

log() { printf '[rollback:%s] %s\n' "$SERVICE" "$*"; }

if ! docker image inspect "$IMAGE:prev" >/dev/null 2>&1; then
  log "no :prev tag — cannot auto-rollback. Manual recovery required." >&2
  exit 3
fi

log "tag $IMAGE:prev → :latest"
docker tag "$IMAGE:prev" "$IMAGE:latest"

log "recreate qufox-$SERVICE"
"${COMPOSE[@]}" up -d --no-deps "qufox-$SERVICE"

# Report to the webhook so qufox_deploy_rollbacks_total ticks. Fail-open:
# if the webhook is down the rollback is still authoritative and the
# metric just under-counts. The endpoint is 127.0.0.1-only and runs on
# the same host as rollback.sh (whether triggered by auto-deploy.sh
# inside the webhook container, or manually by an operator on the NAS).
ROLLBACK_REPORT_URL="${ROLLBACK_REPORT_URL:-http://127.0.0.1:${WEBHOOK_PORT:-9000}/internal/rollback-reported}"
curl -fsS --max-time 2 -X POST "$ROLLBACK_REPORT_URL" >/dev/null 2>&1 || \
  log "(warning) could not report rollback to $ROLLBACK_REPORT_URL"

log "done — container now running previous image"
