#!/usr/bin/env bash
# Post-deploy / switchover sanity check. Confirms the prod stack is serving.
# Exits non-zero on any failed check; prints a checklist so the operator (or
# an agent) can see which component is unhealthy.
#
# (The GitHub-webhook checks were removed in task-076 — deploys are local via
#  scripts/deploy/deploy.sh, which already health-gates each rollout.)

set -euo pipefail

FAIL=0
pass() { printf '  ✓ %s\n' "$*"; }
fail() {
  printf '  ✗ %s\n' "$*" >&2
  FAIL=1
}

echo "== qufox post-deploy smoke =="
echo

echo "1/3 serving containers Up"
for c in qufox-api qufox-web qufox-postgres-prod qufox-redis-prod; do
  if docker ps --filter name="$c" --format '{{.Names}}' | grep -qx "$c"; then
    pass "$c"
  else
    fail "$c is NOT Up — check docker ps + docker logs $c"
  fi
done

echo "2/3 api deep-readiness"
READY_BODY=$(curl -sk --max-time 5 https://qufox.com/api/readyz || echo '')
READY_STATUS=$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' https://qufox.com/api/readyz || echo 000)
if [[ "$READY_STATUS" == "200" ]] && echo "$READY_BODY" | grep -q '"status":"ok"'; then
  pass "qufox.com/api/readyz → 200 + status:ok"
else
  fail "qufox.com/api/readyz → $READY_STATUS, body=$READY_BODY"
fi

echo "3/3 web serving"
WEB_STATUS=$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' https://qufox.com/ || echo 000)
if [[ "$WEB_STATUS" == "200" ]]; then
  pass "qufox.com/ → 200"
else
  fail "qufox.com/ → $WEB_STATUS"
fi

if [[ $FAIL -ne 0 ]]; then
  echo "== SMOKE FAILED =="
  exit 1
fi
echo "== SMOKE OK =="
