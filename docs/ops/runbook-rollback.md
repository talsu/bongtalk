# Runbook — Rollback

Use when the deployed release is serving bad responses (5xx surge,
broken login, wrong UI) but the process is still running — health
checks stopped catching the regression.

## Fastest path: flip `:prev` → `:latest`

```sh
cd /volume2/dockers/qufox
# pick the service: api OR web (rarely both — they move independently)
bash scripts/deploy/rollback.sh api
# or
bash scripts/deploy/rollback.sh web
```

`rollback.sh` re-tags `qufox/<svc>:prev` as `:latest`, then
`docker compose up -d --no-deps qufox-<svc>`. Takes ~10-20s. Safe to run
from the NAS shell at any time, including during an active deploy (the
flock serialises with auto-deploy.sh).

If `:prev` is missing you will see `rollback.sh: no :prev tag`. That
only happens if this is the very first deploy or someone pruned images
by hand — skip to "Rollback to a specific SHA" below.

## Rollback to a specific SHA

```sh
docker image ls qufox/api
# e.g. qufox/api   sha-7f12ab3   abc...   10 minutes ago
docker tag qufox/api:sha-7f12ab3 qufox/api:latest
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  up -d --no-deps qufox-api
```

`IMAGE_HISTORY_KEEP` (default 10) caps how many historical tags exist.
If you need something older than that, rebuild from Git:

```sh
git checkout <sha>
scripts/prod-reload.sh api    # manual path
git checkout main             # never leave the working tree detached
```

## After rollback

1. Confirm `/readyz` returns 200 and `status: ok`.
2. `docker logs --tail 100 qufox-api` — look for the error the bad
   release was emitting; rollback shouldn't reintroduce them.
3. Slack: post "rolled back qufox-api to sha-XXXXXXX, investigating".
4. Open a revert PR on GitHub so `main` and the running image agree;
   the next push will otherwise re-deploy the bad code.

## DB migration compatibility

Rollback **never** reverts migrations. If the failed deploy ran a
schema change that's incompatible with the previous code:

- Additive change (new column, new table): rollback is safe, previous
  code just ignores the new column.
- Destructive change (column drop, type change): rollback is NOT safe.
  You need either a forward-fix release or a DB restore (see
  `runbook-backup-restore.md`) — do NOT rollback silently.

The deploy convention keeps destructive migrations out of the auto
path, so in practice every auto-deploy rollback is safe.
