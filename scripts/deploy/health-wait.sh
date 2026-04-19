#!/usr/bin/env bash
# Poll an HTTP endpoint until it returns < 300. Used after each service
# swap to confirm the new container is actually serving before we commit
# the deploy. The 3-second sleep in the old prod-reload.sh was shorter
# than Nest boot + first DB/Redis handshake; this replaces it.
#
# Usage: health-wait.sh <url> [max_seconds] [interval_seconds]

set -euo pipefail

URL="${1:?health-wait.sh requires url}"
MAX_SECONDS="${2:-120}"
INTERVAL="${3:-2}"

printf '[health-wait] polling %s (max %ss, every %ss)\n' "$URL" "$MAX_SECONDS" "$INTERVAL"

deadline=$(( $(date +%s) + MAX_SECONDS ))
attempt=0
last_status=0
while [[ $(date +%s) -lt $deadline ]]; do
  attempt=$((attempt + 1))
  # -k lets self-signed chains pass (we point at public qufox.com by
  # default, but devs sometimes pass the container-internal URL). -o /dev/null
  # suppresses body, -w prints HTTP status, --max-time caps slow TCP.
  last_status=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$URL" || echo 000)
  if [[ "$last_status" =~ ^[23] ]]; then
    printf '[health-wait] OK after %s attempts (status=%s)\n' "$attempt" "$last_status"
    exit 0
  fi
  sleep "$INTERVAL"
done

printf '[health-wait] FAILED after %ss (last=%s, attempts=%s)\n' \
  "$MAX_SECONDS" "$last_status" "$attempt" >&2
exit 1
