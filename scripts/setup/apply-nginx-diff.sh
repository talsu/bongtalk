#!/usr/bin/env bash
# Print nginx location snippets that need to be pasted INSIDE the
# existing `qufox.com` server block in /volume2/dockers/nginx/nginx.conf.
# Does NOT edit the file — splicing a `location` into a monolithic
# nginx.conf requires AST-aware insertion this script doesn't do.
#
# Task-016 follow-up: the earlier design gave the webhook a dedicated
# `deploy.qufox.com` subdomain. The operator decided against creating
# that subdomain; both the webhook AND the attachments endpoint are
# now served under `qufox.com` as additional `location` blocks.
#
# Usage:
#   scripts/setup/apply-nginx-diff.sh            # print /hooks/github block (default)
#   scripts/setup/apply-nginx-diff.sh --webhook  # same as default, explicit
#   scripts/setup/apply-nginx-diff.sh --attachments  # print /attachments/ block
#   scripts/setup/apply-nginx-diff.sh --all      # print both
#
# After pasting: `docker exec nginx-proxy-1 nginx -t && nginx -s reload`.

set -euo pipefail

MODE=webhook
for arg in "$@"; do
  case "$arg" in
    --webhook) MODE=webhook ;;
    --attachments) MODE=attachments ;;
    --all) MODE=all ;;
    -h|--help)
      sed -n '1,18p' "$0" | tail -17
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[apply-nginx-diff] %s\n' "$*"; }

WEBHOOK_BLOCK=$(cat <<'NGINX'
    # task-016 ops: GitHub webhook receiver → qufox-webhook container.
    # HMAC-verified inside the app; this location exists purely to give
    # GitHub a stable public URL. No /internal/* forwarding — internal
    # metrics stay loopback-only on port 9000 of the host.
    location /hooks/github {
        set $upstream_qufox_webhook http://qufox-webhook:9000;
        proxy_pass $upstream_qufox_webhook;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout  10s;
        proxy_send_timeout  10s;
        # GitHub delivery payloads are capped at 25 MB; anything larger
        # is almost certainly wrong.
        client_max_body_size 25m;
    }
NGINX
)

ATTACHMENTS_BLOCK=$(cat <<'NGINX'
    # task-012-F: /attachments/ pass-through to qufox-minio.
    location /attachments/ {
        set $upstream_qufox_minio http://qufox-minio:9000;
        rewrite ^/attachments/(.*)$ /$1 break;
        proxy_pass $upstream_qufox_minio;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        client_max_body_size 100m;
        proxy_request_buffering off;
        proxy_buffering         off;
        proxy_read_timeout      600s;
        proxy_send_timeout      600s;
    }
NGINX
)

print_block() {
  local name="$1" block="$2"
  log "$name block — paste INSIDE the existing qufox.com server {}:"
  echo
  printf '%s\n' "$block"
  echo
}

case "$MODE" in
  webhook)      print_block "GitHub webhook" "$WEBHOOK_BLOCK" ;;
  attachments)  print_block "/attachments/"   "$ATTACHMENTS_BLOCK" ;;
  all)
    print_block "GitHub webhook" "$WEBHOOK_BLOCK"
    print_block "/attachments/"   "$ATTACHMENTS_BLOCK"
    ;;
esac

log 'after pasting: docker exec nginx-proxy-1 nginx -t && docker exec nginx-proxy-1 nginx -s reload'
log 'verify webhook:     curl -sk -o /dev/null -w "%{http_code}\\n" -X POST https://qufox.com/hooks/github   # → 401 (no signature; means reachable + HMAC gate active)'
log 'verify attachments: curl -sk -o /dev/null -w "%{http_code}\\n" https://qufox.com/attachments/minio/health/live  # → 200'
