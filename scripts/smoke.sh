#!/usr/bin/env bash
# Smoke test: curl /healthz, /readyz, web root; grep for "qufox".
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
WEB_URL="${WEB_URL:-http://localhost:5173}"

echo "[smoke] GET $API_URL/healthz"
curl -fsS "$API_URL/healthz" | tee /tmp/qufox-health.json
echo

echo "[smoke] GET $API_URL/readyz"
curl -fsS "$API_URL/readyz" | tee /tmp/qufox-ready.json
echo

echo "[smoke] GET $WEB_URL/"
body="$(curl -fsS "$WEB_URL/")"
echo "$body" | grep -qi "qufox" || { echo "[smoke] web root missing 'qufox' marker"; exit 1; }

echo "[smoke] ok"
