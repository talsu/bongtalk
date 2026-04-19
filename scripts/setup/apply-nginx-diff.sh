#!/usr/bin/env bash
# Apply the deploy.qufox.com nginx server block from
# docs/ops/runbook-nginx-diff.md into /volume2/dockers/nginx/nginx.conf.
#
# Flow:
#   1. Snapshot nginx.conf to .bak.<epoch>.
#   2. If the `server_name  deploy.qufox.com;` already exists → no-op.
#   3. Otherwise, insert the block inside the http { } scope, before
#      its closing brace.
#   4. `docker exec nginx-proxy-1 nginx -t`. On failure: restore .bak,
#      exit non-zero, leave nginx alive untouched.
#   5. On success: `docker exec nginx-proxy-1 nginx -s reload`.
#
# Usage:
#   scripts/setup/apply-nginx-diff.sh [--dry-run]
#
# Idempotent: rerunning after a successful install is a no-op.

set -euo pipefail

NGINX_CONF="${NGINX_CONF:-/volume2/dockers/nginx/nginx.conf}"
NGINX_CONTAINER="${NGINX_CONTAINER:-nginx-proxy-1}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '1,25p' "$0" | tail -18
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[apply-nginx-diff] %s\n' "$*"; }

if [[ ! -f "$NGINX_CONF" ]]; then
  echo "[apply-nginx-diff] nginx.conf not found at $NGINX_CONF" >&2
  exit 3
fi

# --- idempotency check ---------------------------------------------------
if grep -qE 'server_name[[:space:]]+deploy\.qufox\.com' "$NGINX_CONF"; then
  log "deploy.qufox.com server block already present — no-op"
  exit 0
fi

# --- compose server block ------------------------------------------------
BLOCK=$(cat <<'NGINX'

# deploy.qufox.com — GitHub webhook receiver (qufox-webhook)
# Installed by scripts/setup/apply-nginx-diff.sh (task-011).
server {
    listen 443 ssl http2;
    server_name  deploy.qufox.com;

    ssl_certificate     /etc/letsencrypt/live/talsu.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/talsu.net/privkey.pem;

    client_max_body_size 25m;

    location = /healthz {
        proxy_pass http://qufox-webhook:9000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /hooks/ {
        proxy_pass http://qufox-webhook:9000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout  10s;
        proxy_send_timeout  10s;
    }

    location / {
        return 404;
    }
}

NGINX
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "--dry-run: would snapshot $NGINX_CONF then insert:"
  printf '%s\n' "$BLOCK"
  log "would run: docker exec $NGINX_CONTAINER nginx -t && nginx -s reload"
  exit 0
fi

# --- snapshot ------------------------------------------------------------
STAMP=$(date +%s)
BAK="$NGINX_CONF.bak.$STAMP"
cp -p "$NGINX_CONF" "$BAK"
log "snapshot: $BAK"

# --- append the deploy.qufox.com server block -----------------------------
# task-011 reviewer HIGH-1 fix: the NAS nginx.conf is an include-fragment
# with NO outer `http { }` wrapper — the last `}` closes the last server
# block. Nesting our block inside that server is illegal ("server
# directive is not allowed here"). A top-level server block is the
# correct shape here; plain append is the simplest correct operation.
# If the file DOES have an outer http wrapper on some other deployment,
# `nginx -t` below catches the resulting stray `}` and we auto-rollback.
printf '%s\n' "$BLOCK" >> "$NGINX_CONF"

# --- test + reload (with auto-rollback on failure) -----------------------
if ! docker exec "$NGINX_CONTAINER" nginx -t >/tmp/apply-nginx-diff.nginx-t.log 2>&1; then
  log "nginx -t FAILED — restoring $BAK" >&2
  cat /tmp/apply-nginx-diff.nginx-t.log >&2
  mv "$BAK" "$NGINX_CONF"
  exit 4
fi

docker exec "$NGINX_CONTAINER" nginx -s reload
log "reloaded nginx; deploy.qufox.com now active"
log "snapshot left at $BAK for manual rollback if needed"
