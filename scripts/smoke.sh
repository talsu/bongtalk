#!/usr/bin/env bash
# Smoke test: curl /healthz, /readyz, web root, and auth signup→login→/me.
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
WEB_URL="${WEB_URL:-http://localhost:5173}"
ORIGIN="${CORS_ORIGIN:-http://localhost:45173}"

echo "[smoke] GET $API_URL/healthz"
curl -fsS "$API_URL/healthz" | tee /tmp/qufox-health.json
echo

echo "[smoke] GET $API_URL/readyz"
curl -fsS "$API_URL/readyz" | tee /tmp/qufox-ready.json
echo

echo "[smoke] GET $WEB_URL/"
body="$(curl -fsS "$WEB_URL/")"
echo "$body" | grep -qi "qufox" || { echo "[smoke] web root missing 'qufox' marker"; exit 1; }

# ---- Auth smoke (task-001) ------------------------------------------------
stamp="$(date +%s)"
email="smoke-${stamp}@qufox.dev"
username="smoke${stamp}"
password="Quanta-Beetle-Nebula-42!"
cookie_jar="$(mktemp)"
trap 'rm -f "$cookie_jar"' EXIT

echo "[smoke] POST $API_URL/auth/signup"
signup_json="$(curl -fsS -c "$cookie_jar" -H 'content-type: application/json' -H "origin: $ORIGIN" \
  -X POST "$API_URL/auth/signup" \
  -d "{\"email\":\"$email\",\"username\":\"$username\",\"password\":\"$password\"}")"
access="$(printf '%s' "$signup_json" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')"
if [ -z "$access" ]; then echo "[smoke] signup did not return accessToken"; exit 1; fi

echo "[smoke] GET $API_URL/auth/me (Bearer)"
me_json="$(curl -fsS -H "authorization: Bearer $access" "$API_URL/auth/me")"
echo "$me_json" | grep -q "$username" || { echo "[smoke] /me did not echo username"; exit 1; }

echo "[smoke] POST $API_URL/auth/login"
login_json="$(curl -fsS -c "$cookie_jar" -H 'content-type: application/json' -H "origin: $ORIGIN" \
  -X POST "$API_URL/auth/login" \
  -d "{\"email\":\"$email\",\"password\":\"$password\"}")"
echo "$login_json" | grep -q '"accessToken"' || { echo "[smoke] login did not return accessToken"; exit 1; }

echo "[smoke] POST $API_URL/auth/logout"
curl -fsS -b "$cookie_jar" -c "$cookie_jar" -H "origin: $ORIGIN" \
  -X POST "$API_URL/auth/logout" -o /dev/null

echo "[smoke] ok"
