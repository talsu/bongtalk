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
#
# S72 (D13 / FR-W15): the purge now follows the PRD-mandated order
# (ADR-013, single anonymization policy):
#   ① MinIO: delete attachment + custom-emoji objects for the workspace
#      (best-effort; the attachment rows are also flagged finalizedAt=NULL
#      so attachment-orphan-gc reclaims any object the direct delete missed)
#   ② anonymize Message.authorId → SYSTEM_ANON (content preserved, author
#      masked) in LIMIT batches so a huge channel doesn't lock the table
#   ③ mark SavedMessage.messageDeletedAt = NOW() (before the Message CASCADE
#      removes the rows it references)
#   ④ DELETE FROM "Workspace" — CASCADE removes Channel / Category / Role /
#      Member / Message / SavedMessage(via Message) automatically
# Steps ②–④ run inside a single BEGIN/COMMIT per workspace so an interrupted
# purge never leaves a half-anonymized aggregate. Step ① is non-transactional
# (MinIO is not in the DB tx) and idempotent.
#
# restore↔purge race: the final DELETE re-checks `deleteAt < NOW()`, so a
# workspace `restore`d (deleteAt=NULL) between SELECT and DELETE is skipped
# automatically — no row is removed and the candidate is simply dropped.

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

# Prisma's DATABASE_URL carries `?schema=public` which libpq rejects;
# psql only needs the base URL (attachment-orphan-gc precedent).
PGURL="${DATABASE_URL%%\?*}"

# S72 (D13 / FR-W15): the system user that owns anonymized messages. env
# ANON_AUTHOR_UUID overrides; otherwise the deterministic uuid v5 default
# (SEED_NAMESPACE + 'user:system-anon') that seed.ts also uses. We INSERT
# it idempotently below so anonymization never violates the
# Message.authorId → User FK even on a fresh prod DB whose seed predates
# this user.
ANON_UUID="${ANON_AUTHOR_UUID:-871aa8f6-f28a-5e26-ba8f-37ca7126e9e3}"

# S72: anonymize Message rows in batches of this size so a workspace with
# millions of messages doesn't take one giant row lock. Tunable via env.
ANON_BATCH_SIZE="${WORKSPACE_PURGE_ANON_BATCH:-5000}"

CANDIDATES=$(psql "$PGURL" -At -F '|' -c \
  'SELECT id, slug FROM "Workspace"
   WHERE "deleteAt" IS NOT NULL
     AND "deleteAt" < NOW()
   LIMIT 500')

if [[ -z "$CANDIDATES" ]]; then
  log "no workspaces past their grace window"
  exit 0
fi

# S72: ensure the SYSTEM_ANON user exists before any anonymization. Idempotent
# (ON CONFLICT DO NOTHING) so it is safe to run every purge tick. Only attempted
# on a real (non-dry-run) pass since dry-run performs no writes. The password
# hash is a non-loginable placeholder (no plaintext maps to it).
if [[ "$DRY_RUN" -eq 0 ]]; then
  psql "$PGURL" >/dev/null <<SQL
INSERT INTO "User" (id, email, username, "passwordHash", "emailVerified")
VALUES (
  '$ANON_UUID',
  'anon@system.qufox',
  'deleted-user',
  'x-no-login-$ANON_UUID',
  true
)
ON CONFLICT (id) DO NOTHING;
SQL
fi

# S72: best-effort MinIO object delete for a workspace's attachments + custom
# emojis (step ①). Non-transactional — MinIO is outside the DB tx. Skipped when
# S3 env is absent (dev / dry-run) so the DB-only purge still works. The
# attachment rows are ALSO flagged finalizedAt=NULL inside the tx below, so
# attachment-orphan-gc reclaims any object this best-effort pass misses.
purge_minio_objects() {
  local ws_id="$1"
  if [[ -z "${S3_ENDPOINT:-}" || -z "${S3_BUCKET:-}" || -z "${S3_ACCESS_KEY_ID:-}" || -z "${S3_SECRET_ACCESS_KEY:-}" ]]; then
    log "  minio: S3 env not set — skipping object delete (orphan-gc will reclaim attachments)"
    return 0
  fi
  export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}"
  local keys
  keys=$(psql "$PGURL" -At -c \
    "SELECT \"storageKey\" FROM \"Attachment\"
       WHERE \"channelId\" IN (SELECT id FROM \"Channel\" WHERE \"workspaceId\" = '$ws_id')
         AND \"storageKey\" IS NOT NULL
     UNION ALL
     SELECT \"storageKey\" FROM \"CustomEmoji\" WHERE \"workspaceId\" = '$ws_id'")
  local count=0
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    # delete-object is idempotent (missing key = success), matching orphan-gc.
    aws s3api delete-object --endpoint-url "$S3_ENDPOINT" \
      --bucket "$S3_BUCKET" --key "$key" >/dev/null 2>&1 || \
      log "  minio: delete failed for key=$key (orphan-gc fallback)"
    count=$((count + 1))
  done <<<"$keys"
  log "  minio: requested delete of $count object(s)"
}

# S72: anonymize Message.authorId → SYSTEM_ANON in bounded batches (step ②).
# Runs inside the per-workspace transaction. Loops until no more rows match so
# a workspace larger than one batch is fully anonymized before the CASCADE.
anonymize_messages_sql() {
  local ws_id="$1"
  cat <<SQL
DO \$\$
DECLARE
  affected INTEGER;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id FROM "Message"
       WHERE "channelId" IN (SELECT id FROM "Channel" WHERE "workspaceId" = '$ws_id')
         AND "authorId" <> '$ANON_UUID'
       LIMIT $ANON_BATCH_SIZE
    )
    UPDATE "Message" SET "authorId" = '$ANON_UUID'
     WHERE id IN (SELECT id FROM batch);
    GET DIAGNOSTICS affected = ROW_COUNT;
    RAISE NOTICE '[workspace-purge] anonymized % message rows', affected;
    EXIT WHEN affected = 0;
  END LOOP;
END
\$\$;
SQL
}

COUNT=0
while IFS='|' read -r ID SLUG; do
  [[ -z "$ID" ]] && continue
  COUNT=$((COUNT + 1))
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "would purge: id=$ID slug=$SLUG"
    continue
  fi

  log "purging id=$ID slug=$SLUG"
  # ① MinIO objects (non-transactional, best-effort, idempotent).
  purge_minio_objects "$ID"

  # ②–④ in a single transaction. The final DELETE re-checks deleteAt < NOW()
  # so a workspace restored between SELECT and now is skipped (restore↔purge
  # race contract). CASCADE on Channel / Message / SavedMessage(via Message) /
  # WorkspaceMember / Category / Role / Invite handles the rest.
  psql "$PGURL" >/dev/null <<SQL
BEGIN;
-- ② anonymize message authors (content preserved) in bounded batches.
$(anonymize_messages_sql "$ID")
-- ③ mark SavedMessage rows referencing this workspace's messages as
--    source-deleted BEFORE the Message CASCADE removes the FK target.
UPDATE "SavedMessage" SET "messageDeletedAt" = NOW()
  WHERE "messageDeletedAt" IS NULL
    AND "messageId" IN (
      SELECT m.id FROM "Message" m
      JOIN "Channel" c ON c.id = m."channelId"
      WHERE c."workspaceId" = '$ID'
    );
-- (orphan-flag attachments so attachment-orphan-gc reclaims any MinIO object
--  the best-effort step ① missed — finalizedAt=NULL is its selector.)
UPDATE "Attachment" SET "finalizedAt" = NULL
  WHERE "channelId" IN (SELECT id FROM "Channel" WHERE "workspaceId" = '$ID');
-- ④ hard-delete the workspace (CASCADE). Re-check the grace boundary so a
--    concurrent restore wins the race (deleteAt set back to NULL → no match).
DELETE FROM "Workspace"
  WHERE id = '$ID'
    AND "deleteAt" IS NOT NULL
    AND "deleteAt" < NOW();
COMMIT;
SQL
  log "purged id=$ID slug=$SLUG"
done <<<"$CANDIDATES"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry-run: $COUNT workspace(s) would be purged"
else
  log "ok: $COUNT workspace(s) purged"
fi
