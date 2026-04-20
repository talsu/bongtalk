# Runbook — Nginx diff for `qufox.com /hooks/github` and `/attachments/`

The webhook + attachments both live under the existing `qufox.com`
server block as additional `location` directives. There is **no**
`deploy.qufox.com` subdomain — that was the original 009 design but
the operator decided to keep everything on the apex domain, so the
server block, DNS record, and TLS SAN for `deploy.qufox.com` are
unneeded and should NOT be added.

## Prerequisite

`qufox.com` already has a TLS cert and a server block in
`/volume2/dockers/nginx/nginx.conf`. Nothing new at the cert or DNS
layer — this runbook is purely about adding two location directives
inside the block that is already there.

## The snippets

Run `scripts/setup/apply-nginx-diff.sh --all` to print both blocks
formatted for paste. Drop them INSIDE the existing `qufox.com`
server block (near the `/api/` location is a good spot).

```nginx
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
    client_max_body_size 25m;
}
```

(See the `--attachments` mode in the same script for the
`/attachments/` location — same shape but 100 MB body + buffering
off + 600 s timeout.)

## Apply

```sh
docker exec nginx-proxy-1 nginx -t
docker exec nginx-proxy-1 nginx -s reload
```

## Verify

```sh
# Unsigned POST — expected 401 (HMAC gate active, nginx reached the webhook).
curl -sk -o /dev/null -w '%{http_code}\n' -X POST https://qufox.com/hooks/github
# → 401

# Internal healthz (not exposed publicly — loopback only):
docker exec qufox-webhook wget -qO- http://127.0.0.1:9000/healthz
# → {"status":"ok", ...}
```

## Rollback

If a location directive breaks something:

```sh
# 1. comment out the new location{} block inside the qufox.com server{}
# 2. reload
docker exec nginx-proxy-1 nginx -s reload
# app stays up because the rest of the server block is untouched.
```

---

## Task-012-F additive: `/attachments/` location on the existing `qufox.com` server block

Paste inside the existing `server { server_name qufox.com; … }` block
(the one that already routes `/api/` and `/socket.io/`). Do NOT create
a second server block for `qufox.com` — nginx rejects duplicate host
names at the same listen port.

```nginx
    # task-012-F: pass-through to qufox-minio for attachment uploads
    # (presigned PUT) + downloads (presigned GET). Streaming both
    # directions so a 100 MB upload doesn't buffer in nginx.
    location /attachments/ {
        proxy_pass http://qufox-minio:9000/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Task-012-B caps single-attachment uploads at 100 MB; the
        # location-scoped limit overrides the 25m set on the
        # deploy.qufox.com block above (nginx scopes
        # client_max_body_size per location).
        client_max_body_size 100m;

        # Stream PUT body straight through to MinIO. Without these,
        # nginx would buffer the whole 100 MB before forwarding —
        # which both wastes disk AND ties up an api worker slot per
        # upload.
        proxy_request_buffering off;
        proxy_buffering         off;

        # Large files over slow links take minutes; the defaults (60s)
        # would abort mid-upload.
        proxy_read_timeout      600s;
        proxy_send_timeout      600s;
    }
```

The MinIO admin console (port 9001) is intentionally NOT exposed on
the public edge. Operators open it via an SSH tunnel to port 9001
on the NAS:

```sh
ssh -L 9001:qufox-minio:9001 admin@<nas-host>
# then open http://localhost:9001 in a local browser
```

### Apply + verify

```sh
docker exec nginx-proxy-1 nginx -t
docker exec nginx-proxy-1 nginx -s reload

# MinIO health through the public edge (expects 200 on the raw
# health path; MinIO does NOT require auth for /minio/health/live).
curl -sk -o /dev/null -w '%{http_code}\n' \
  https://qufox.com/attachments/minio/health/live
# → 200

# A presign round-trip smoke (driven by init-minio.sh after the
# bucket exists) proves the signed URL path resolves end-to-end.
```
