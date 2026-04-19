# syntax=docker/dockerfile:1.7
# Minimal cron-driven backup runner. Uses busybox crond so we don't have
# to deal with cron.d/cron.daily layout differences across distros.
FROM alpine:3.19

RUN apk add --no-cache \
      bash \
      curl \
      postgresql16-client \
      redis \
      docker-cli \
      tzdata \
      tini \
      coreutils

WORKDIR /app
COPY scripts/backup /app/scripts/backup
COPY services/backup/entrypoint.sh /entrypoint.sh
RUN chmod +x /app/scripts/backup/*.sh /entrypoint.sh

ENV TZ=UTC \
    BACKUP_DIR=/backups \
    BACKUP_DAILY_KEEP=14 \
    BACKUP_WEEKLY_KEEP=8 \
    BACKUP_CRON="30 3 * * *" \
    RESTORE_TEST_CRON="45 4 * * 0"

VOLUME ["/backups"]
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
