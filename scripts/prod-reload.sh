#!/usr/bin/env bash
# Rebuild + redeploy the qufox production stack.
#
# Usage:
#   scripts/prod-reload.sh            # rebuild + recreate both api & web
#   scripts/prod-reload.sh api        # only api
#   scripts/prod-reload.sh web        # only web
#
# Expects .env.prod at repo root and the shared `internal` Docker network.
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-all}"
COMPOSE=(docker compose --env-file .env.prod -f docker-compose.prod.yml)

case "$TARGET" in
  api)    SVC=(qufox-api) ;;
  web)    SVC=(qufox-web) ;;
  all|"") SVC=(qufox-api qufox-web) ;;
  *) echo "unknown target: $TARGET (expected: api | web | all)"; exit 2 ;;
esac

echo "==> building: ${SVC[*]}"
"${COMPOSE[@]}" build "${SVC[@]}"

echo "==> recreating: ${SVC[*]}"
"${COMPOSE[@]}" up -d --no-deps "${SVC[@]}"

echo "==> health check"
sleep 3
curl -skf https://qufox.com/api/healthz >/dev/null && echo "  api OK" || echo "  api FAIL"
curl -skf https://qufox.com/ -o /dev/null && echo "  web OK" || echo "  web FAIL"
