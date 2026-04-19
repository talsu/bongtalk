# Switchover checklist — task-009 deploy stack → live beta

One-time procedure. Run from the NAS (`/volume2/dockers/qufox`) during
a quiet hour. Every step prints its own log; stop at the first failure
and check the rollback column before continuing.

## Pre-flight

Verify the three switchover scripts are present, executable, and parse:

```sh
bash scripts/deploy/test-syntax.sh
```

Expected: `ok: all deploy/backup scripts parse`.

Also confirm a DNS A record for `deploy.qufox.com` points at the NAS
and a TLS cert covers it (the existing `talsu.net` wildcard chain is
reused — see `docs/ops/runbook-nginx-diff.md § Prerequisite`).

## Steps

| #   | Operator action                                                                                               | Automation runs                                                                                    | Validation                                                                                                                   | Rollback on failure                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `bash scripts/setup/init-env-deploy.sh --dry-run`                                                             | Prints the `.env.deploy` that would be written; NO disk write                                      | exit code 0; webhook secret shown is throwaway                                                                               | n/a — dry run                                                                                                                              |
| 2   | `bash scripts/setup/init-env-deploy.sh`                                                                       | Writes `.env.deploy` (0600), generates HMAC secret, prints once                                    | `stat -c %a .env.deploy` → 600                                                                                               | `rm .env.deploy` and re-run                                                                                                                |
| 3   | Paste webhook secret into GitHub (Repo → Settings → Webhooks → Add)                                           | Operator manual                                                                                    | GitHub shows the webhook with "Recent Deliveries" (empty is fine)                                                            | Delete the webhook                                                                                                                         |
| 4   | `mkdir -p /volume1/secrets/qufox-ssh && ssh-keygen -t ed25519 -f /volume1/secrets/qufox-ssh/id_ed25519 -N ""` | Generates a read-only deploy key                                                                   | File exists + readable by uid running webhook                                                                                | `rm -rf /volume1/secrets/qufox-ssh`                                                                                                        |
| 5   | Paste `id_ed25519.pub` into GitHub (Repo → Settings → Deploy keys → Add; check "Allow write access" OFF)      | Operator manual                                                                                    | `ssh -T git@github.com -i /volume1/secrets/qufox-ssh/id_ed25519` prints "Hi <user>/<repo>!"                                  | Revoke deploy key in GitHub                                                                                                                |
| 6   | `mkdir -p /volume1/backups/qufox && chmod 0700 /volume1/backups/qufox`                                        | Backup dir present                                                                                 | `ls -ld /volume1/backups/qufox` → drwx------ admin users                                                                     | `rmdir /volume1/backups/qufox`                                                                                                             |
| 7   | `docker compose --env-file .env.deploy --env-file .env.prod -f compose.deploy.yml up -d`                      | Builds + starts qufox-webhook + qufox-backup                                                       | `docker ps --filter name=qufox-webhook --format '{{.Status}}'` → `Up`                                                        | `docker compose -f compose.deploy.yml down`                                                                                                |
| 8   | `bash scripts/setup/apply-nginx-diff.sh --dry-run`                                                            | Prints the block that would insert; nginx NOT touched                                              | exit 0 + diff shown                                                                                                          | n/a                                                                                                                                        |
| 9   | `bash scripts/setup/apply-nginx-diff.sh`                                                                      | Snapshots nginx.conf → .bak.<epoch>, inserts deploy.qufox.com block, `nginx -t`, `nginx -s reload` | exit 0                                                                                                                       | Auto: restores .bak on nginx -t failure. Manual: `mv <bak> /volume2/dockers/nginx/nginx.conf && docker exec nginx-proxy-1 nginx -s reload` |
| 10  | `bash scripts/setup/post-switchover-smoke.sh`                                                                 | 4 checks: webhook healthz, containers Up, api readyz, prints webhook redelivery cmd                | exit 0 + all ✓                                                                                                               | Step-specific (see script output)                                                                                                          |
| 11  | GitHub → Webhooks → Recent Deliveries → Redeliver the ping                                                    | Manual (GitHub UI)                                                                                 | 200 `{"pong":true}`                                                                                                          | Re-check secret + `docker logs qufox-webhook --tail 50`                                                                                    |
| 12  | Merge a no-op PR into `main` to fire the first real deploy                                                    | GitHub push → webhook → auto-deploy                                                                | `docker logs qufox-webhook --tail 200` shows `deploy.enqueue` then `deploy.result exitCode=0`; qufox-api container recreated | `bash scripts/deploy/rollback.sh api`                                                                                                      |
| 13  | Wait ~24h for first daily backup cron + confirm file landed at `/volume1/backups/qufox/postgres/`             | Automation (qufox-backup crond)                                                                    | `ls -lht /volume1/backups/qufox/postgres/` shows a dump from today                                                           | `docker exec qufox-backup /app/scripts/backup/db-backup.sh` re-runs it                                                                     |
| 14  | Wait ~7d for weekly restore-smoke + confirm Slack/stdout log                                                  | Automation                                                                                         | `docker logs qufox-backup --since 168h` grep `restore-test`                                                                  | `docker exec qufox-backup /app/scripts/backup/restore-test.sh`                                                                             |

## Done criteria

- Steps 1-11 complete in one session; step 12 runs cleanly; 13/14 land
  on schedule.
- `docker logs qufox-webhook --tail 50` shows only `request.ping`,
  `deploy.enqueue`, `deploy.result exitCode=0` lines; no
  `request.reject`.
- `docs/tasks/011-beta-switchover.PR.md` updated with "switchover
  completed YYYY-MM-DD by <operator>".

## If something breaks

- `docker logs qufox-webhook --tail 200` is the first thing to read.
- `/volume2/dockers/qufox/.deploy/audit.jsonl` has the full history.
- `scripts/prod-reload.sh` still works as a manual fallback and now
  shares the flock with the webhook (task-011-C, MED-2 fix).
- `docs/ops/runbook-webhook-debug.md` has the triage tree.
