# Runbook — Postgres PITR (task-036)

## Topology

- `qufox-postgres-prod` runs with `wal_level=replica`, `archive_mode=on`,
  `archive_command` copying to `/wal-archive` (bind-mounted from
  `/volume3/qufox-data/backups/pg-wal`).
- `scripts/backup/pg-base-backup.sh` runs weekly (Sunday 02:00) via
  the qufox-backup container's crontab — produces a tarball under
  `/volume3/qufox-data/backups/pg-base/<timestamp>/`. 4-backup
  retention.
- `scripts/backup/pitr-restore-test.sh` runs weekly (Sunday 03:00) —
  spins a throwaway `postgres:16-alpine` container, restores the latest
  base + replays the WAL archive, runs `SELECT COUNT(*) FROM "User"`
  as a smoke, cleans up, and writes a `last-restore-ok` marker + a
  `pitr-metrics.prom` textfile with `qufox_pitr_restore_last_success_timestamp`.
- Prometheus alert `PitrRestoreStale` fires when that timestamp is
  > 8 days old.

## Manual restore on the prod box (emergency)

Stop writes first (put the stack in maintenance via the webhook pause
flag or scale `qufox-api` to 0). Then:

```sh
# 1. Identify the target timestamp.
TARGET="2026-04-23 03:00:00 UTC"

# 2. Stop postgres.
docker stop qufox-postgres-prod

# 3. Move the current data dir aside.
docker run --rm -v qufox-prod-pgdata:/pgdata alpine \
  sh -c 'mv /pgdata /pgdata.busted && mkdir -p /pgdata && chown -R 70:70 /pgdata'

# 4. Extract the latest base into the fresh volume.
LATEST=$(ls -1d /volume3/qufox-data/backups/pg-base/20* | sort -r | head -1)
docker run --rm \
  -v qufox-prod-pgdata:/pgdata \
  -v "$LATEST":/base:ro \
  alpine sh -c 'tar -xzf /base/base.tar.gz -C /pgdata && [ -f /base/pg_wal.tar.gz ] && tar -xzf /base/pg_wal.tar.gz -C /pgdata/pg_wal || true'

# 5. Stage recovery.
docker run --rm \
  -v qufox-prod-pgdata:/pgdata \
  alpine sh -c "touch /pgdata/recovery.signal && printf \"restore_command = 'cp /wal-archive/%%f %%p'\nrecovery_target_time = '$TARGET'\nrecovery_target_action = 'promote'\n\" >> /pgdata/postgresql.auto.conf"

# 6. Bring postgres back up — recovery runs, then the server promotes.
docker start qufox-postgres-prod
docker logs -f qufox-postgres-prod | grep -iE 'recovery|promote'
```

## Drill script (automated)

`scripts/backup/pitr-restore-test.sh` is the automation. Manual run:

```sh
bash /volume2/dockers/qufox/scripts/backup/pitr-restore-test.sh
cat /volume3/qufox-data/backups/pg-base/pitr-runs.log | tail
cat /volume3/qufox-data/backups/pg-base/last-restore-ok
```

`last-restore-ok` contains the UTC timestamp of the last successful
drill; `pitr-metrics.prom` is the text-file exporter file that the
Prometheus job (once wired via node_exporter `--collector.textfile.
directory`) scrapes for the `PitrRestoreStale` alert.

## Follow-up

`TODO(task-036-follow-textfile-exporter)` — wire node_exporter (or an
existing exporter) with `--collector.textfile.directory=/volume3/
qufox-data/backups/pg-base` so Prometheus can evaluate the stale-drill
rule without extra plumbing.
