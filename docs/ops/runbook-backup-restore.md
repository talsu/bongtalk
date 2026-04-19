# Runbook — Backup & Restore

## What we back up

| Source          | Strategy                  | Location                                     | Retention          |
| --------------- | ------------------------- | -------------------------------------------- | ------------------ |
| PostgreSQL      | `pg_dump --format=custom` | `$BACKUP_DIR/postgres/qufox-YYYY-MM-DD.dump` | daily 14, weekly 8 |
| Postgres weekly | copy on Sunday            | `$BACKUP_DIR/postgres/weekly/`               | 8 weeks            |
| Redis           | `BGSAVE` + gzip           | `$BACKUP_DIR/redis/qufox-YYYY-MM-DD.rdb.gz`  | daily 14           |

`$BACKUP_DIR` defaults to `/volume3/qufox-data/backups/qufox` (different volume
from `/volume2` where the app lives — cheap protection against a
single-volume FS corruption).

## Schedule

Set in `.env.deploy`:

```
BACKUP_CRON='30 3 * * *'            # daily, 03:30 UTC
RESTORE_TEST_CRON='45 4 * * 0'      # weekly, Sunday 04:45 UTC
```

The `qufox-backup` container runs `crond -f`. First backup also runs
at container boot so a fresh install is never without a snapshot.

## Verifying the system is alive

```sh
ls -lht /volume3/qufox-data/backups/qufox/postgres/ | head -5
ls -lht /volume3/qufox-data/backups/qufox/redis/ | head -5
docker logs qufox-backup --tail 50
```

Each file should be within the last 24h and larger than the previous
run's shrunken-by-rotation minimum (empty files are a failure mode —
`pg_dump` writing 0 bytes means auth or network failed).

## Weekly restore smoke

`restore-test.sh` spins an ephemeral postgres:16, pg_restores the
newest dump, and runs `SELECT COUNT(*) FROM "User"`. Nonzero = pass.
Alert fires on failure via the cron container's log pipe (monitored by
whatever watches `docker logs qufox-backup`).

Run it manually any time:

```sh
docker exec qufox-backup /app/scripts/backup/restore-test.sh
```

## Full restore procedure

⚠ Destructive — coordinate with team before running against prod.

### Postgres

```sh
# 1. pick the dump
ls -lht /volume3/qufox-data/backups/qufox/postgres/
DUMP=/volume3/qufox-data/backups/qufox/postgres/qufox-YYYY-MM-DD.dump

# 2. stop the API so no live writes race the restore
docker stop qufox-api

# 3. drop & recreate the database INSIDE the existing postgres
docker exec -it qufox-postgres-prod psql -U qufox -d postgres -c 'DROP DATABASE qufox WITH (FORCE);'
docker exec -it qufox-postgres-prod psql -U qufox -d postgres -c 'CREATE DATABASE qufox OWNER qufox;'

# 4. pg_restore — bind the dump in as a read-only volume for this one shot
docker run --rm \
  --network internal \
  -v "$DUMP":/tmp/dump:ro \
  -e PGPASSWORD="$POSTGRES_PASSWORD" \
  postgres:16-alpine \
  pg_restore -h qufox-postgres-prod -U qufox -d qufox --no-owner --no-privileges /tmp/dump

# 5. restart API
docker start qufox-api

# 6. verify /readyz is 200 and you can log in
```

### Redis

Redis holds only derived state (rate limits, presence, outbox). Usually
the right move is to `FLUSHALL` and let the app rebuild:

```sh
docker exec qufox-redis-prod redis-cli FLUSHALL
```

If you need to actually restore a dump:

```sh
docker stop qufox-redis-prod
gunzip -c /volume3/qufox-data/backups/qufox/redis/qufox-YYYY-MM-DD.rdb.gz > /tmp/dump.rdb
docker cp /tmp/dump.rdb qufox-redis-prod:/data/dump.rdb
docker start qufox-redis-prod
rm /tmp/dump.rdb
```

## If backups are missing or corrupt

1. Stop writes where possible (`docker stop qufox-api`) — preserves the
   live DB as the last known good.
2. Run `docker exec qufox-backup /app/scripts/backup/db-backup.sh`
   directly to confirm the pipeline works.
3. Check NAS disk space: `df -h /volume1`.
4. Check network: `docker exec qufox-backup nc -vz qufox-postgres-prod 5432`.
