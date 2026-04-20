#!/usr/bin/env bash
# Post-switchover sanity check. Run after init-env-deploy.sh + apply-nginx-diff.sh
# to confirm the beta stack is serving. Exits non-zero on any failed check;
# prints a checklist so the operator can see which steps still need hand-work.

set -euo pipefail

FAIL=0
pass() { printf '  ✓ %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*" >&2; FAIL=1; }

echo "== task-011 post-switchover smoke =="
echo

echo "1/4 webhook container health"
# task-016 ops: the webhook was merged into the qufox.com apex
# instead of the original deploy.qufox.com subdomain, and internal
# /healthz is not exposed through the public nginx location. Reach
# it via docker exec so the HMAC-gated public path stays untouched.
if docker ps --filter name=qufox-webhook --format '{{.Names}}' | grep -qx qufox-webhook; then
  if docker exec qufox-webhook wget -qO- --tries=1 --timeout=5 http://127.0.0.1:9000/healthz \
      2>/dev/null | grep -q '"status":"ok"'; then
    pass 'qufox-webhook /healthz (internal) → ok'
  else
    fail 'qufox-webhook /healthz (internal) — container is Up but healthz did not return ok'
  fi
  # Public surface: any POST without a signature should be 401 — proves
  # the /hooks/github location is reachable and the HMAC gate is active.
  PUB_STATUS=$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' \
    -X POST https://qufox.com/hooks/github || echo 000)
  if [[ "$PUB_STATUS" == "401" ]]; then
    pass 'qufox.com/hooks/github (unsigned POST) → 401 (gate active)'
  else
    fail "qufox.com/hooks/github (unsigned POST) → $PUB_STATUS (expected 401 — check nginx location)"
  fi
else
  fail 'qufox-webhook container is NOT Up — bring up compose.deploy.yml first'
fi

echo "2/4 docker containers Up"
for c in qufox-webhook qufox-backup qufox-api qufox-web qufox-postgres-prod qufox-redis-prod; do
  if docker ps --filter name="$c" --format '{{.Names}}' | grep -qx "$c"; then
    pass "$c"
  else
    fail "$c is NOT Up — check docker ps + docker logs $c"
  fi
done

echo "3/4 api deep-readiness"
READY_BODY=$(curl -sk --max-time 5 https://qufox.com/api/readyz || echo '')
READY_STATUS=$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' https://qufox.com/api/readyz || echo 000)
if [[ "$READY_STATUS" == "200" ]] && echo "$READY_BODY" | grep -q '"status":"ok"'; then
  pass "qufox.com/api/readyz → 200 + status:ok"
else
  fail "qufox.com/api/readyz → $READY_STATUS, body=$READY_BODY"
fi

echo "4/4 GitHub webhook redelivery (manual step)"
echo "  The script cannot poll GitHub for redelivery status (requires a"
echo "  personal access token). Redeliver the most recent ping manually:"
echo
echo "    Repo → Settings → Webhooks → Recent Deliveries → Redeliver"
echo
echo "  Expected response: 200 {\"pong\":true}"
echo
echo "  Or redeliver from the NAS with curl (replace <secret> with"
echo "  GITHUB_WEBHOOK_SECRET from .env.deploy):"
echo
echo "    PAYLOAD='{}'"
echo '    SIG=$(printf "%s" "$PAYLOAD" | openssl dgst -sha256 -hmac "<secret>" | awk "{print \$2}")'
echo "    curl -sk -X POST https://qufox.com/hooks/github \\"
echo "      -H 'x-github-event: ping' \\"
echo "      -H \"x-hub-signature-256: sha256=\$SIG\" \\"
echo "      -d \"\$PAYLOAD\""
echo

if [[ $FAIL -ne 0 ]]; then
  echo "== SMOKE FAILED =="
  exit 1
fi
echo "== SMOKE OK =="
