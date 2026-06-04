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
#   ③ DELETE FROM "Workspace" — CASCADE removes Channel / Category / Role /
#      Member / Message / SavedMessage(via Message) automatically
# Steps ②–③ run inside a single BEGIN/COMMIT per workspace so an interrupted
# purge never leaves a half-anonymized aggregate. Step ① is non-transactional
# (MinIO is not in the DB tx) and idempotent.
#
# S72 fix-forward (reviewer H2 = purge BLOCKER): restore↔purge race. The
# transaction now opens with `SELECT ... FOR UPDATE` on the target row and
# re-checks `deletedAt IS NOT NULL AND deleteAt < NOW()` BEFORE anonymizing.
# If a concurrent `restore` (deletedAt=NULL) wins the narrow window, the row
# fails the eligibility re-check and the whole transaction is ROLLBACK'd — so
# the anonymization (formerly committed regardless of the DELETE row count)
# never persists on a workspace that was restored. Anonymize + DELETE share
# the exact same eligibility predicate, gated under the row lock.
#
# S72 fix-forward (reviewer M3 = purge MEDIUM): the SavedMessage
# `messageDeletedAt = NOW()` marking step was removed — SavedMessage.message
# is `onDelete: Cascade`, so the same transaction's DELETE FROM "Workspace"
# (→ Channel → Message CASCADE) deletes those SavedMessage rows immediately.
# Marking them first was a dead write against rows about to vanish.

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

# S72 fix-forward (security MEDIUM): ANON_UUID is interpolated into SQL string
# literals below, so validate it is a canonical UUID before any use — this shuts
# the env→SQL injection surface (a crafted ANON_AUTHOR_UUID could otherwise carry
# a quote + payload). Reject (log + exit 1) anything that isn't 8-4-4-4-12 hex.
if ! printf '%s' "$ANON_UUID" | grep -Eiq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  log "FATAL: ANON_AUTHOR_UUID is not a valid UUID: '$ANON_UUID'"
  exit 1
fi

# S72: anonymize Message rows in batches of this size so a workspace with
# millions of messages doesn't take one giant row lock. Tunable via env.
ANON_BATCH_SIZE="${WORKSPACE_PURGE_ANON_BATCH:-5000}"

# S72 fix-forward (security MEDIUM): ANON_BATCH_SIZE is interpolated into the
# anonymization LIMIT, so it must be a bare positive integer (no SQL payload).
if ! printf '%s' "$ANON_BATCH_SIZE" | grep -Eq '^[1-9][0-9]*$'; then
  log "FATAL: WORKSPACE_PURGE_ANON_BATCH must be a positive integer: '$ANON_BATCH_SIZE'"
  exit 1
fi

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
# so it is safe to run every purge tick. Only attempted on a real (non-dry-run)
# pass since dry-run performs no writes. The passwordHash is a non-argon2 sentinel
# ('x-no-login-<uuid>') — verify() fails structurally against it, so no plaintext
# can ever log in (matches seed.ts, #5).
#
# S72 fix-forward (security MEDIUM): the username 'deleted-user' is UNIQUE, so a
# plain `ON CONFLICT (id) DO NOTHING` would NOT catch a row that already holds
# that username under a *different* id — the INSERT would then raise a unique
# violation and fail the purge. We guard both unique columns: skip the INSERT
# entirely if EITHER the id OR the reserved username already exists. If the id
# exists we are done; if only the username is taken (a pre-existing row reserved
# it) we likewise do nothing — anonymization targets $ANON_UUID by id regardless,
# and a missing id surfaces as an FK error we'd rather see loudly than mask.
if [[ "$DRY_RUN" -eq 0 ]]; then
  psql "$PGURL" >/dev/null <<SQL
INSERT INTO "User" (id, email, username, "passwordHash", "emailVerified")
SELECT '$ANON_UUID', 'anon@system.qufox', 'deleted-user', 'x-no-login-$ANON_UUID', true
WHERE NOT EXISTS (
  SELECT 1 FROM "User" WHERE id = '$ANON_UUID' OR username = 'deleted-user'
);
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

  # ②–③ in a single transaction, gated by a row-lock eligibility re-check.
  #
  # S72 fix-forward (reviewer H2 = purge BLOCKER): the transaction opens with
  # SELECT ... FOR UPDATE on the target row and re-checks the SAME eligibility
  # predicate (deletedAt IS NOT NULL AND deleteAt < NOW()) that gates the DELETE.
  # If a concurrent restore (deletedAt=NULL / deleteAt=NULL) won the narrow window
  # between the candidate SELECT and now, the lock returns 0 eligible rows and we
  # \if-skip BOTH the anonymization and the DELETE, then ROLLBACK — so the
  # anonymization never persists on a restored workspace (it used to COMMIT
  # regardless of the DELETE row count). Anonymize + DELETE share one predicate.
  #
  # ON_ERROR_STOP aborts (and the open tx rolls back) on any SQL error.
  psql "$PGURL" -v ON_ERROR_STOP=1 -q >/dev/null <<SQL
BEGIN;
-- Lock the candidate row and re-confirm eligibility under the lock. eligible=t
-- only when the workspace is still soft-deleted AND past its grace window.
SELECT EXISTS (
  SELECT 1 FROM "Workspace"
   WHERE id = '$ID'
     AND "deletedAt" IS NOT NULL
     AND "deleteAt" < NOW()
   FOR UPDATE
) AS eligible \gset
\if :eligible
-- ② anonymize message authors (content preserved) in bounded batches.
$(anonymize_messages_sql "$ID")
-- (orphan-flag attachments so attachment-orphan-gc reclaims any MinIO object
--  the best-effort step ① missed — finalizedAt=NULL is its selector.)
UPDATE "Attachment" SET "finalizedAt" = NULL
  WHERE "channelId" IN (SELECT id FROM "Channel" WHERE "workspaceId" = '$ID');
-- ③ hard-delete the workspace (CASCADE removes Channel / Message /
--    SavedMessage(via Message) / WorkspaceMember / Category / Role / Invite).
--    The eligibility predicate above already gated this under the row lock.
DELETE FROM "Workspace" WHERE id = '$ID';
COMMIT;
\else
-- Restored (or otherwise ineligible) under the lock — undo everything, touch nothing.
\echo '[workspace-purge] skipped (restored or no longer eligible under lock)'
ROLLBACK;
\endif
SQL
  log "purged id=$ID slug=$SLUG"
done <<<"$CANDIDATES"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry-run: $COUNT workspace(s) would be purged"
else
  log "ok: $COUNT workspace(s) purged"
fi
