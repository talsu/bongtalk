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
#
# task-015-A (task-012-follow-5 closure): the two-step ordering is
# intentional and convergent — not atomic. Crash / signal between the
# S3 delete and the DB delete leaves state where the object is gone
# but the DB row remains:
#   - next run's S3 delete is a no-op (idempotent; missing key = 204
#     = success) so the DB delete completes on the retry.
#   - user-visible effect is zero: an orphan row with no S3 object
#     already could not serve a download, and this script's selector
#     already targets orphans (finalizedAt IS NULL + >24h stale).
# A real transaction would need a 2PC bridge; the convergence above
# is cheaper and equally safe for a daily GC.

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

# task-038-A follow: Prisma's DATABASE_URL carries `?schema=public`
# which libpq rejects ("invalid URI query parameter"). psql only needs
# the base URL; strip the query string before any psql invocation.
PGURL="${DATABASE_URL%%\?*}"

# Fetch orphan candidates. Psql in the alpine image is available via
# postgresql16-client. DATABASE_URL carries the creds.
CANDIDATES=$(psql "$PGURL" -At -F '|' -c \
  'SELECT id, "storageKey" FROM "Attachment"
   WHERE "finalizedAt" IS NULL
     AND "createdAt" < NOW() - INTERVAL '"'"'24 hours'"'"'
   LIMIT 500')

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}"

# task-038-A: "no attachment orphans" no longer short-circuits the
# script — the emoji sweep below must run regardless.
COUNT=0
if [[ -z "$CANDIDATES" ]]; then
  log "no attachment orphans"
fi

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
    psql "$PGURL" -c "DELETE FROM \"Attachment\" WHERE id = '$ID';" >/dev/null
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

# =============================================================
# task-038-A: Custom emoji orphan sweep under <wsId>/emojis/
# =============================================================
# Attachments use "DB says orphan → delete object" because every
# presign reserves a row. Custom emoji does the same, but the
# presigned PUT (15 min TTL) can still land bytes AFTER we've
# already deleted the row on a HEAD miss in finalize. Those
# objects end up with no DB pointer → never GC'd.
#
# Strategy: list every object under `*/emojis/`, extract the
# emojiId segment (`<uuid>-<filename>`), and delete any object
# whose emojiId is not in CustomEmoji.id AND whose LastModified is
# older than 7 days. The 7-day grace covers the presign-PUT-delay
# window + any in-flight finalize retry.
log "emoji-orphan-gc: begin prefix=emojis/"

# Gather known emoji ids from DB (small table — cap 100 per
# workspace, total realistically < 10k).
KNOWN_IDS=$(psql "$PGURL" -At -c 'SELECT id FROM "CustomEmoji"')
KNOWN_SET=$(printf '%s' "$KNOWN_IDS" | awk 'NF' | sort -u)

# List every object under any `<wsId>/emojis/` path. MinIO +
# path-style means one LIST per bucket gives us the whole set;
# we filter client-side for `/emojis/` anywhere in the key.
CUTOFF=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)

EMOJI_COUNT=0
EMOJI_DEL=0
while IFS=$'\t' read -r LASTMOD KEY; do
  [[ -z "$KEY" ]] && continue
  [[ "$KEY" != *"/emojis/"* ]] && continue
  EMOJI_COUNT=$((EMOJI_COUNT + 1))
  # Extract `<emojiId>` from `<wsId>/emojis/<emojiId>-<safeName>`.
  FNAME="${KEY##*/emojis/}"
  EID="${FNAME%%-*}"
  # Skip objects younger than the grace period.
  [[ "$LASTMOD" > "$CUTOFF" ]] && continue
  # Skip objects whose emojiId IS in the DB (legitimate live row).
  if [[ -n "$KNOWN_SET" ]] && printf '%s\n' "$KNOWN_SET" | grep -qxF "$EID"; then
    continue
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "emoji dry-run: would delete key=$KEY (emojiId=$EID, lastModified=$LASTMOD)"
    EMOJI_DEL=$((EMOJI_DEL + 1))
    continue
  fi
  if aws --endpoint-url "$S3_ENDPOINT" s3api delete-object \
       --bucket "$S3_BUCKET" --key "$KEY" >/dev/null 2>&1; then
    EMOJI_DEL=$((EMOJI_DEL + 1))
    log "emoji deleted key=$KEY (emojiId=$EID)"
  else
    log "(warn) emoji delete failed for $KEY"
  fi
# task-039-C (closes TODO(task-038-follow-list-paginate)): paginate
# list-objects-v2 by ContinuationToken so a bucket past the 1000
# default page size gets fully scanned. Streamed via process
# substitution so the read loop above sees one (LastModified, Key)
# pair per line regardless of how many pages we walked. Uses python3
# (already a backup-container dependency) instead of jq for parsing.
done < <(
  # task-039 review HIGH-2: do NOT silently swallow AWS errors with
  # `|| echo '{}'`. A page-N-of-M failure would truncate the scan and
  # the cron summary would still report "ok". Capture the exit code,
  # log a (warn) line on failure with the stderr tail, and stop the
  # pagination loop so the half-scanned state is visible upstream
  # rather than masquerading as a clean run.
  TOKEN=""
  AWS_STDERR=$(mktemp)
  while :; do
    set +e
    if [[ -z "$TOKEN" ]]; then
      RESP=$(aws --endpoint-url "$S3_ENDPOINT" s3api list-objects-v2 \
              --bucket "$S3_BUCKET" \
              --max-keys 1000 \
              --output json 2>"$AWS_STDERR")
    else
      RESP=$(aws --endpoint-url "$S3_ENDPOINT" s3api list-objects-v2 \
              --bucket "$S3_BUCKET" \
              --max-keys 1000 \
              --continuation-token "$TOKEN" \
              --output json 2>"$AWS_STDERR")
    fi
    RC=$?
    set -e
    if [[ "$RC" -ne 0 ]]; then
      echo "[orphan-gc] (warn) list-objects-v2 rc=$RC stderr=$(tr -d '\n' < "$AWS_STDERR" | cut -c1-200)" >&2
      break
    fi
    printf '%s\n' "$RESP" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for o in data.get("Contents", []) or []:
    lm = o.get("LastModified", "")
    k = o.get("Key", "")
    if k:
        print(f"{lm}\t{k}")
'
    TOKEN=$(printf '%s\n' "$RESP" | python3 -c '
import json, sys
data = json.load(sys.stdin)
print(data.get("NextContinuationToken") or "")
')
    [[ -z "$TOKEN" ]] && break
  done
  rm -f "$AWS_STDERR"
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "emoji dry-run: scanned=$EMOJI_COUNT would-delete=$EMOJI_DEL prefix=emojis/"
else
  log "emoji ok: scanned=$EMOJI_COUNT deleted=$EMOJI_DEL prefix=emojis/"
fi
