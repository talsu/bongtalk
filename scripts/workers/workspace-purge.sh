#!/usr/bin/env bash
# Task-013-A2 (task-034 closure): hard-delete workspaces whose soft-
# delete grace window has elapsed.
#
# Schema contract: `softDelete` in workspaces.service.ts sets
# `deletedAt = now()` and `deleteAt = now() + WORKSPACE_SOFT_DELETE_GRACE_DAYS`.
# During the grace window `restore` can un-delete. After grace, this
# worker deletes the row. `Workspace` FK cascades from 002 handle
# Channel / Message / WorkspaceMember / Invite rows automatically.
#
# --dry-run lists what would be deleted without removing anything.
# Runs from qufox-backup via cron at $WORKSPACE_PURGE_CRON (default
# 00 05 * * * — daily at 05:00 UTC, after the db + minio backups).

set -euo pipefail

DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

log() { printf '[workspace-purge] %s\n' "$*"; }

# Matching init-minio + attachment-orphan-gc: --dry-run without env
# exits 0 with a friendly note so a fresh checkout or CI-syntax-smoke
# pass doesn't 1 out.
if [[ "$DRY_RUN" -eq 1 && -z "${DATABASE_URL:-}" ]]; then
  log "--dry-run without DATABASE_URL — would list candidate workspaces here"
  log "(set DATABASE_URL to exercise the real query)"
  exit 0
fi

: "${DATABASE_URL:?DATABASE_URL required}"

CANDIDATES=$(psql "$DATABASE_URL" -At -F '|' -c \
  'SELECT id, slug FROM "Workspace"
   WHERE "deleteAt" IS NOT NULL
     AND "deleteAt" < NOW()
   LIMIT 500')

if [[ -z "$CANDIDATES" ]]; then
  log "no workspaces past their grace window"
  exit 0
fi

COUNT=0
while IFS='|' read -r ID SLUG; do
  [[ -z "$ID" ]] && continue
  COUNT=$((COUNT + 1))
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "would purge: id=$ID slug=$SLUG"
    continue
  fi
  # CASCADE on Channel/Message/WorkspaceMember/Invite foreign keys means
  # a single DELETE on Workspace cleans the whole aggregate. Any
  # Attachment rows the cascade removes leave MinIO objects behind —
  # those are picked up by attachment-orphan-gc.sh on the next nightly
  # run (its finalizedAt-IS-NULL filter would miss them, so we
  # explicitly prune the attachments by channel id first to flag
  # them as orphans the GC picks up).
  psql "$DATABASE_URL" <<SQL >/dev/null
BEGIN;
UPDATE "Attachment" SET "finalizedAt" = NULL
  WHERE "channelId" IN (SELECT id FROM "Channel" WHERE "workspaceId" = '$ID');
DELETE FROM "Workspace" WHERE id = '$ID';
COMMIT;
SQL
  log "purged id=$ID slug=$SLUG"
done <<<"$CANDIDATES"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry-run: $COUNT workspace(s) would be purged"
else
  log "ok: $COUNT workspace(s) purged"
fi
