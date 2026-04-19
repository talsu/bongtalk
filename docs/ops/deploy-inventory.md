# Production deploy inventory (pre task-009 automation)

Snapshot of the manual deploy surface _before_ the webhook CD work lands.
Kept for future humans who need to reason about what the old path did.

## Manual entrypoint

`scripts/prod-reload.sh` — 34 lines, run by hand on the NAS.

Flow:

1. `docker compose --env-file .env.prod -f docker-compose.prod.yml build <svc>`
2. `docker compose ... up -d --no-deps <svc>` (recreate)
3. `sleep 3 && curl https://qufox.com/api/healthz`

Known gaps this task addresses:

- no health-wait loop (3s is shorter than typical Nest boot)
- no rollback (image tag stays `:latest`; previous image is gone)
- no backups (Postgres + Redis data has never been dumped off the live volume)
- no audit log / notification / concurrency lock
- no HMAC-secured remote trigger — deploy requires shell access

## Production containers (docker-compose.prod.yml)

| service               | image                | network    | volume                   |
| --------------------- | -------------------- | ---------- | ------------------------ |
| `qufox-postgres-prod` | `postgres:16-alpine` | `internal` | `qufox-prod-pgdata`      |
| `qufox-redis-prod`    | `redis:7-alpine`     | `internal` | (ephemeral, BGSAVE only) |
| `qufox-api`           | `qufox/api:latest`   | `internal` | —                        |
| `qufox-web`           | `qufox/web:latest`   | `internal` | —                        |

`internal` is `external: true` — owned by `/volume2/dockers/nginx/nginx-proxy-1`.

## Nginx edge

`/volume2/dockers/nginx/nginx.conf` qufox.com block:

- `location /api/` → `http://qufox-api:3001` (`rewrite ^/api/(.*)$ /$1 break;`)
- `location /socket.io/` → same upstream (WebSocket + sticky)
- cert: `/etc/letsencrypt/live/talsu.net/fullchain.pem`

Task-009 does **not** modify this file. The nginx diff for the new
`deploy.qufox.com` host is supplied as `docs/ops/runbook-nginx-diff.md`;
the operator applies it and runs `nginx -s reload` manually.

## Env layout

- `.env.prod` — `0600 admin:users`, 18 keys. Consumed by
  `docker-compose.prod.yml` via `env_file` and `--env-file`.
- `.env.prod.example` — tracked skeleton.
- `.env.deploy` — **new** file introduced by task-009. Holds webhook +
  backup + notification secrets, kept separate so rotating the deploy
  secret doesn't require editing `.env.prod`.
- `.env.deploy.example` — **new**, tracked skeleton.

## Scheduler

Synology's `admin` account has no personal crontab (DSM runs
`/usr/syno/bin/synoschedtask` under root). Rather than edit `/etc/crontab`
we run a dedicated `qufox-backup` container whose entrypoint is a cron
loop — the schedule lives in repo, is code-reviewed, and travels with
the project.

## Backup target

`/volume1/backups/qufox/` — `/volume1` has 1.6 TB free, `/volume2` (where
all qufox containers live) has ~120 GB. Keeping backups on a different
volume is also a cheap defence against single-volume filesystem
corruption.

## What stays manual after task-009

- nginx reload (new deploy.qufox.com server block)
- rotating GitHub webhook secret (runbook documents the steps)
- initial `.env.deploy` creation on the NAS
- DSM package / firmware updates
- destructive DB migrations (an extra approval gate stays human)
