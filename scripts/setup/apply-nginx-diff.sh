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
#   scripts/setup/apply-nginx-diff.sh [--dry-run] [--attachments]
#
# --attachments prints the task-012-F `/attachments/` location block
# that operators paste by hand INSIDE the existing qufox.com server
# block (this file is a single monolithic nginx.conf; splicing a
# location into a shared server block is manual — see
# docs/ops/runbook-nginx-diff.md § Task-012-F additive).
#
# Idempotent: rerunning the default (deploy.qufox.com) mode after a
# successful install is a no-op.

set -euo pipefail

NGINX_CONF="${NGINX_CONF:-/volume2/dockers/nginx/nginx.conf}"
NGINX_CONTAINER="${NGINX_CONTAINER:-nginx-proxy-1}"
DRY_RUN=0
MODE=deploy

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --attachments) MODE=attachments ;;
    -h|--help)
      sed -n '1,30p' "$0" | tail -22
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[apply-nginx-diff] %s\n' "$*"; }

if [[ ! -f "$NGINX_CONF" ]]; then
  echo "[apply-nginx-diff] nginx.conf not found at $NGINX_CONF" >&2
  exit 3
fi

# task-015-A (task-012-follow-4 closure): pre-check the file shape.
# The script assumes the NAS nginx.conf is an include fragment (no
# outer `http { }` wrapper). If the file DOES have a top-level http
# block, appending a `server { }` at EOF lands OUTSIDE that block and
# nginx -t rolls us back — but we can detect it up front and refuse
# to touch, with a clearer remediation message than a post-reload
# rollback log. Two heuristics: an opening `http {` at line start
# before any `server {`, AND that block reaches the end of the file.
if grep -nE '^[[:space:]]*http[[:space:]]*\{' "$NGINX_CONF" >/dev/null 2>&1 \
  && ! grep -nE '^[[:space:]]*}[[:space:]]*#.*[Ee]nd.*http' "$NGINX_CONF" >/dev/null 2>&1; then
  # File has an `http {` and no "end http" sentinel — likely a
  # monolithic nginx.conf. Bail out unless the operator opts in.
  if [[ "${ALLOW_HTTP_WRAPPER:-0}" != "1" ]]; then
    echo "[apply-nginx-diff] $NGINX_CONF appears to contain an outer 'http {' block." >&2
    echo "[apply-nginx-diff] EOF-appending a server block would land OUTSIDE that wrapper and fail nginx -t." >&2
    echo "[apply-nginx-diff] Move the deploy.qufox.com block into the http { } manually, or re-run with ALLOW_HTTP_WRAPPER=1 to force append + rely on auto-rollback." >&2
    exit 5
  fi
fi

# --- task-012-F /attachments/ location (manual paste helper) -------------
# Splicing a `location` into an existing `server { server_name qufox.com;
# ... }` inside a shared nginx.conf requires AST-aware insertion that
# this shell script doesn't do. Instead we print the block for the
# operator to paste and run `nginx -t && nginx -s reload` by hand.
# task-012 reviewer HIGH-4 fix.
if [[ "$MODE" == "attachments" ]]; then
  ATTACHMENTS_BLOCK=$(cat <<'NGINX'
    # task-012-F: /attachments/ pass-through to qufox-minio.
    location /attachments/ {
        proxy_pass http://qufox-minio:9000/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 100m;
        proxy_request_buffering off;
        proxy_buffering         off;
        proxy_read_timeout      600s;
        proxy_send_timeout      600s;
    }
NGINX
)
  if grep -qE 'location[[:space:]]+/attachments/' "$NGINX_CONF"; then
    log "attachments location already present in $NGINX_CONF — no-op"
    exit 0
  fi
  log "task-012-F /attachments/ block (paste INSIDE the existing qufox.com server block):"
  echo
  printf '%s\n' "$ATTACHMENTS_BLOCK"
  echo
  log "after pasting: docker exec $NGINX_CONTAINER nginx -t && nginx -s reload"
  log "verification: curl -sk -o /dev/null -w '%{http_code}' https://qufox.com/attachments/minio/health/live → 200"
  exit 0
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
