# Runbook — Deploy

How a production deploy happens end-to-end, what's automatic, and what
to watch. Read this once before trusting the system to rebuild qufox.com
without you looking.

## Normal path (automated)

1. A commit lands on `main` on GitHub.
2. GitHub POSTs to `https://deploy.qufox.com/hooks/github` with
   `X-Hub-Signature-256`.
3. `qufox-webhook` verifies HMAC, checks branch against
   `DEPLOY_BRANCH_ALLOWLIST`, enqueues the SHA. Response is 202.
4. Webhook spawns `scripts/deploy/auto-deploy.sh`.
5. `auto-deploy.sh` acquires the flock, `git fetch` + `git checkout --force <sha>`,
   runs `prisma migrate deploy`, then `rollout.sh api` → `rollout.sh web`.
6. Each `rollout.sh` builds, tags `:latest` → `:prev`, `:latest` → `:sha-<short>`,
   recreates the container, and polls `/readyz` (or `/`) up to 120s.
7. On health failure, `rollout.sh` invokes `rollback.sh` and exits 1;
   `auto-deploy.sh` stops before the next service, container runs the
   previous image.
8. Slack receives start + end message.
9. Stale `:sha-*` tags beyond `IMAGE_HISTORY_KEEP` are pruned.

Every state change writes one line to `.deploy/audit.jsonl`.
Container stdout logs are also copied to `.deploy/logs/deploy-*.log`.

## What to watch during a deploy

- Audit log tail: `docker exec qufox-webhook tail -f /repo/.deploy/audit.jsonl`
- Container status: `docker ps --filter name=qufox-`
- API health during the swap: `while true; do curl -sk https://qufox.com/api/readyz | jq .; sleep 2; done`
- Slack channel for start/done/failed messages

## Expected timing

| Phase                 | Typical | Abort threshold    |
| --------------------- | ------- | ------------------ |
| git fetch + checkout  | < 5s    | 30s → exit 2       |
| prisma migrate deploy | < 10s   | no hard cap; watch |
| api build             | 40-90s  | —                  |
| api recreate + ready  | 10-30s  | 120s → rollback    |
| web build             | 15-40s  | —                  |
| web recreate + ready  | < 10s   | 120s → rollback    |
| total                 | ~2-4min | ~6min              |

If total time is > 10min something is stuck — check the live log
under `.deploy/logs/`.

## Manual path (escape hatch)

`scripts/prod-reload.sh [api|web|all]` still works and — as of
task-011-C MED-2 — acquires the same flock as the webhook. A manual
reload will wait (or exit 75 via `flock -n`) if the webhook is
mid-deploy, and vice versa. Use it when the webhook itself is sick;
if the webhook is healthy, prefer `git push` so the audit trail
exists.

## Things that don't auto-deploy

- `nginx.conf` edits (operator applies + `nginx -s reload`)
- `.env.prod` edits (redeploy picks them up on next build, but a
  var-only change needs a manual `scripts/prod-reload.sh`)
- DB migrations flagged destructive — manual approval, see
  `runbook-backup-restore.md` before running
- Webhook + backup images themselves — rebuild with
  `docker compose --env-file .env.deploy -f compose.deploy.yml build`
