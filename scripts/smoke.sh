#!/usr/bin/env bash
# Smoke: healthz/readyz + web root + auth signup→login→/me + workspace create/invite/accept.
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

# ---- Workspace smoke (task-002) -------------------------------------------
slug="ws-${stamp:(-8)}"
echo "[smoke] POST $API_URL/workspaces ($slug)"
ws_json="$(curl -fsS -H 'content-type: application/json' -H "origin: $ORIGIN" \
  -H "authorization: Bearer $access" \
  -X POST "$API_URL/workspaces" \
  -d "{\"name\":\"SmokeWs\",\"slug\":\"$slug\"}")"
ws_id="$(printf '%s' "$ws_json" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$ws_id" ] || { echo "[smoke] workspace create missing id"; exit 1; }

echo "[smoke] POST $API_URL/workspaces/$ws_id/invites"
inv_json="$(curl -fsS -H 'content-type: application/json' -H "origin: $ORIGIN" \
  -H "authorization: Bearer $access" \
  -X POST "$API_URL/workspaces/$ws_id/invites" -d '{"maxUses":3}')"
inv_code="$(printf '%s' "$inv_json" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$inv_code" ] || { echo "[smoke] invite create missing code"; exit 1; }

echo "[smoke] GET $API_URL/invites/$inv_code (preview)"
curl -fsS "$API_URL/invites/$inv_code" | grep -q "SmokeWs" || { echo "[smoke] invite preview missing workspace name"; exit 1; }

# Second user accepts the invite
email2="smoke2-${stamp}@qufox.dev"
username2="smoke2${stamp}"
signup2_json="$(curl -fsS -H 'content-type: application/json' -H "origin: $ORIGIN" \
  -X POST "$API_URL/auth/signup" \
  -d "{\"email\":\"$email2\",\"username\":\"$username2\",\"password\":\"$password\"}")"
access2="$(printf '%s' "$signup2_json" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')"
echo "[smoke] POST $API_URL/invites/$inv_code/accept (user2)"
curl -fsS -H "authorization: Bearer $access2" -H "origin: $ORIGIN" \
  -X POST "$API_URL/invites/$inv_code/accept" -o /dev/null

echo "[smoke] GET $API_URL/workspaces/$ws_id/members"
members_json="$(curl -fsS -H "authorization: Bearer $access" -H "origin: $ORIGIN" \
  "$API_URL/workspaces/$ws_id/members")"
echo "$members_json" | grep -q "$username2" || { echo "[smoke] member list missing joiner"; exit 1; }

echo "[smoke] POST $API_URL/auth/logout"
curl -fsS -b "$cookie_jar" -c "$cookie_jar" -H "origin: $ORIGIN" \
  -X POST "$API_URL/auth/logout" -o /dev/null

echo "[smoke] ok"
