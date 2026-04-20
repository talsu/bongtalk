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
   runs `prisma migrate deploy`, runs every `scripts/deploy/sql/*.sql` hook
   in alphabetical order, then `rollout.sh api` → `rollout.sh web`.
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

| Phase                 | Typical | Abort threshold                     |
| --------------------- | ------- | ----------------------------------- |
| git fetch + checkout  | < 5s    | 30s → exit 2                        |
| prisma migrate deploy | < 10s   | no hard cap; watch                  |
| deploy-hook SQL       | < 5s    | fail → deploy aborts before rollout |
| api build             | 40-90s  | —                                   |
| api recreate + ready  | 10-30s  | 120s → rollback                     |
| web build             | 15-40s  | —                                   |
| web recreate + ready  | < 10s   | 120s → rollback                     |
| total                 | ~2-4min | ~6min                               |

If total time is > 10min something is stuck — check the live log
under `.deploy/logs/`.

## Manual path (escape hatch)

`scripts/prod-reload.sh [api|web|all]` still works and — as of
task-011-C MED-2 — acquires the same flock as the webhook. A manual
reload will wait (or exit 75 via `flock -n`) if the webhook is
mid-deploy, and vice versa. Use it when the webhook itself is sick;
if the webhook is healthy, prefer `git push` so the audit trail
exists.

## Deploy-hook SQL (`scripts/deploy/sql/*.sql`)

Non-transactional DDL that Prisma's migrate-deploy cannot host —
`CREATE INDEX CONCURRENTLY`, `REINDEX`, `VACUUM`, anything that
refuses to run inside a transaction.

**When to add one:** a migration needs DDL that Postgres forbids
inside a transaction. Write a Prisma migration for everything else
(tables, columns, plain indexes on empty tables). Add a hook only
when the transactional form would freeze the prod DB.

**Required shape:**

- File name: `task-NNN-<short>.sql` (alphabetical order = execution
  order).
- Idempotent: `CREATE ... IF NOT EXISTS`, `DROP ... IF EXISTS`,
  `UPDATE ... WHERE <already-satisfied>`. The same file re-runs on
  every deploy; a second run must be a no-op.
- No `BEGIN`/`COMMIT` — psql runs each statement in autocommit mode
  under `-v ON_ERROR_STOP=1`.

**Recovery when a hook fails mid-run:**

1. Deploy aborts BEFORE the rollout (prev containers stay live).
2. Inspect the error in the deploy log (`.deploy/logs/`).
3. Fix the SQL in place, push; next deploy re-runs the hook from
   scratch. The failed statement runs fresh; earlier statements
   no-op via `IF NOT EXISTS`.
4. If the hook is structurally broken (e.g. wrong index name
   already in use), the fix is usually to DROP the partial object
   manually in `psql` then push the corrected hook. Document that
   step in the hook file's top comment if you expect it.

**Testing before push:**

```sh
psql -v ON_ERROR_STOP=1 -U qufox -d qufox -f scripts/deploy/sql/<file>.sql
# Re-run — should be silent (no "already exists" errors).
psql -v ON_ERROR_STOP=1 -U qufox -d qufox -f scripts/deploy/sql/<file>.sql
```

## Things that don't auto-deploy

- `nginx.conf` edits (operator applies + `nginx -s reload`)
- `.env.prod` edits (redeploy picks them up on next build, but a
  var-only change needs a manual `scripts/prod-reload.sh`)
- DB migrations flagged destructive — manual approval, see
  `runbook-backup-restore.md` before running
- Webhook + backup images themselves — rebuild with
  `docker compose --env-file .env.deploy -f compose.deploy.yml build`
