#!/usr/bin/env bash
# Entrypoint for the qufox-backup container. Seeds crontab from env,
# drops it into /etc/crontabs/root, and hands off to busybox crond.
# Logs go to /proc/1/fd/1 so `docker logs qufox-backup` sees them in
# real time.

set -euo pipefail

: "${BACKUP_CRON:=30 3 * * *}"
: "${RESTORE_TEST_CRON:=45 4 * * 0}"

cat >/etc/crontabs/root <<EOF
# qufox backup schedule (UTC)
$BACKUP_CRON /app/scripts/backup/db-backup.sh >/proc/1/fd/1 2>/proc/1/fd/2
$BACKUP_CRON /app/scripts/backup/redis-backup.sh >/proc/1/fd/1 2>/proc/1/fd/2
$RESTORE_TEST_CRON /app/scripts/backup/restore-test.sh >/proc/1/fd/1 2>/proc/1/fd/2
EOF

# One-shot on boot so the first snapshot lands without waiting up to 24h.
if [[ "${BACKUP_ON_BOOT:-true}" == "true" ]]; then
  echo "[entrypoint] running boot-time backup"
  /app/scripts/backup/db-backup.sh || echo "[entrypoint] initial db-backup failed (non-fatal)" >&2
  /app/scripts/backup/redis-backup.sh || echo "[entrypoint] initial redis-backup failed (non-fatal)" >&2
fi

echo "[entrypoint] starting crond"
exec crond -f -L /dev/stdout
