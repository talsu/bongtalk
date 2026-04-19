# Runbook — Nginx diff for `deploy.qufox.com`

Task-009 **does not** touch `/volume2/dockers/nginx/nginx.conf`
automatically. The operator applies this diff once, at the "first
automatic deploy" switchover (see `docs/ops/deploy-inventory.md`).

## Prerequisite: TLS cert

The existing wildcard-ish cert at `/etc/letsencrypt/live/talsu.net/`
serves `qufox.com`, `stream.qufox.com`, etc. Add `deploy.qufox.com`
to its SAN:

```sh
# inside the certbot container (same pattern used for other *.qufox.com)
certbot --nginx -d talsu.net -d qufox.com -d stream.qufox.com \
  -d deploy.qufox.com   # ← new
# or with the DNS-01 plugin, reuse whatever issued the current cert
```

DNS: point `deploy.qufox.com` A record at the same public IP as
`qufox.com`.

## The diff

Drop this block into `/volume2/dockers/nginx/nginx.conf` next to the
existing `qufox.com` server block:

```nginx
# deploy.qufox.com — GitHub webhook receiver (qufox-webhook)
server {
    listen 443 ssl http2;
    server_name  deploy.qufox.com;

    ssl_certificate     /etc/letsencrypt/live/talsu.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/talsu.net/privkey.pem;

    # Accept GitHub's payload up to 25 MB (matches main qufox.com).
    client_max_body_size 25m;

    # Anti-abuse: only accept POST /hooks/* and GET /healthz.
    # Everything else is 404 — the receiver also does this, but a second
    # layer at the edge trims log noise and cuts port-scan surface.
    location = /healthz {
        proxy_pass http://qufox-webhook:9000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /hooks/ {
        # GitHub delivers push events up to ~24 MB (monorepo diffs).
        proxy_pass http://qufox-webhook:9000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # GitHub waits up to 10s before marking a delivery failed.
        proxy_read_timeout  10s;
        proxy_send_timeout  10s;
    }

    location / {
        return 404;
    }
}

# Also add deploy.qufox.com to the port 80 → 443 redirect server.
# In the existing server_name list find:
#     server_name  talsu.net git.talsu.net ... qufox.com ...
# Append:
#     deploy.qufox.com
```

## Apply

```sh
# 1. test the config before reloading
docker exec nginx-proxy-1 nginx -t
# 2. reload
docker exec nginx-proxy-1 nginx -s reload
```

## Verify

```sh
curl -sk -o /dev/null -w '%{http_code}\n' https://deploy.qufox.com/healthz
# → 200
curl -sk -X POST https://deploy.qufox.com/hooks/github \
  -H 'x-github-event: ping' -d '{}'
# → 401 (bad signature) — this is correct: nginx reached the webhook
```

## Rollback

If the new block breaks something:

```sh
# 1. comment out the new server{} block
# 2. reload
docker exec nginx-proxy-1 nginx -s reload
# app stays up because the edge change is additive and the app has its
# own hostname (qufox.com) untouched.
```
