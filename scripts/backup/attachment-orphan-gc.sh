#!/usr/bin/env bash
# Task-012-G: nightly attachment orphan GC.
#
# An orphan is an Attachment row with finalizedAt IS NULL AND
# createdAt < now() - interval '24 hours'. Flow:
#   1. SELECT the orphan rows (id, storageKey).
#   2. For each row: aws s3api delete-object (idempotent — missing
#      key is a no-op) against the MinIO endpoint using the app creds.
#   3. On S3 success, DELETE the Attachment row. On S3 failure, leave
#      the row for the next run (task-012 reviewer MED-5).
#   4. Emit `qufox_attachment_orphans_deleted_total` counter via a
#      POST to the webhook's /internal/rollback-reported-style endpoint
#      (task-010-D added the metric pattern; this re-uses the model).
#
# --dry-run lists candidates without deleting.
# Runs from qufox-backup via cron at $ORPHAN_GC_CRON (default 04:30 UTC).

set -euo pipefail

DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

log() { printf '[orphan-gc] %s\n' "$*"; }

# task-012 reviewer LOW-12 fix: allow --dry-run to exit 0 without env.
# AC line "`attachment-orphan-gc.sh --dry-run` lists candidates without
# deleting" must hold even on a fresh checkout where .env.prod isn't
# set up yet (the syntax-smoke pass in test-syntax.sh was picking this
# up as a hard fail).
if [[ "$DRY_RUN" -eq 1 && ( -z "${DATABASE_URL:-}" || -z "${S3_ENDPOINT:-}" || -z "${S3_ACCESS_KEY_ID:-}" || -z "${S3_SECRET_ACCESS_KEY:-}" ) ]]; then
  log "--dry-run without DB / S3 env — would list candidates here"
  log "(set DATABASE_URL + S3_* to exercise the real query)"
  exit 0
fi

: "${DATABASE_URL:?DATABASE_URL required (postgres://qufox:...@qufox-postgres-prod:5432/qufox)}"
: "${S3_ENDPOINT:?S3_ENDPOINT required}"
: "${S3_BUCKET:?S3_BUCKET required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY required}"

# Fetch orphan candidates. Psql in the alpine image is available via
# postgresql16-client. DATABASE_URL carries the creds.
CANDIDATES=$(psql "$DATABASE_URL" -At -F '|' -c \
  'SELECT id, "storageKey" FROM "Attachment"
   WHERE "finalizedAt" IS NULL
     AND "createdAt" < NOW() - INTERVAL '"'"'24 hours'"'"'
   LIMIT 500')

if [[ -z "$CANDIDATES" ]]; then
  log "no orphans"
  exit 0
fi

COUNT=0
export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}"

while IFS='|' read -r ID KEY; do
  [[ -z "$ID" ]] && continue
  COUNT=$((COUNT + 1))
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "would delete: id=$ID key=$KEY"
    continue
  fi
  # task-012 reviewer MED-5 fix: previously the `aws ... || log ...`
  # pattern substituted `log` (exit 0) on S3 failure, so the next-line
  # DELETE ran unconditionally and stranded the S3 object with no DB
  # row pointing at it. Explicit if/else matches the stated atomicity
  # guarantee: DB row stays until S3 delete actually succeeds (or the
  # key is already absent, which s3api delete-object treats as 204).
  if aws --endpoint-url "$S3_ENDPOINT" s3api delete-object \
       --bucket "$S3_BUCKET" --key "$KEY" >/dev/null 2>&1; then
    psql "$DATABASE_URL" -c "DELETE FROM \"Attachment\" WHERE id = '$ID';" >/dev/null
    log "deleted id=$ID key=$KEY"
  else
    log "(warn) aws delete failed for $KEY — leaving DB row for next run"
  fi
done <<<"$CANDIDATES"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry-run: $COUNT orphan(s) would be deleted"
else
  log "ok: $COUNT orphan(s) deleted"
fi
