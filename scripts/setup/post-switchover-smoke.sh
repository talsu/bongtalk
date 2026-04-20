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
if curl -skf --max-time 5 https://deploy.qufox.com/healthz >/dev/null; then
  pass 'deploy.qufox.com/healthz → 200'
else
  fail 'deploy.qufox.com/healthz NOT reachable — nginx block or TLS cert issue'
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
echo "    curl -sk -X POST https://deploy.qufox.com/hooks/github \\"
echo "      -H 'x-github-event: ping' \\"
echo "      -H \"x-hub-signature-256: sha256=\$SIG\" \\"
echo "      -d \"\$PAYLOAD\""
echo

if [[ $FAIL -ne 0 ]]; then
  echo "== SMOKE FAILED =="
  exit 1
fi
echo "== SMOKE OK =="
