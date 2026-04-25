#!/usr/bin/env bash
# task-039-C fixture test: upload 1500 dummy objects to a throwaway
# MinIO bucket, run attachment-orphan-gc.sh --dry-run against it, and
# assert that the scanned counter reaches 1500 (proving the
# list-objects-v2 ContinuationToken loop walks beyond the 1000-page
# default).
#
# Runs from the host (or qufox-backup container) — needs aws CLI +
# python3 + the same S3 creds used by prod backups. Cleans up the
# temp bucket on exit.
set -euo pipefail

: "${S3_ENDPOINT:?S3_ENDPOINT required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY required}"
# task-039 review HIGH-1: refuse to run without DATABASE_URL — the
# orphan-gc script's first step is a `psql` query and a stub URL
# would `connection refused` under `set -euo pipefail`, killing the
# script before the emoji sweep runs. The fixture's `scanned=N`
# assertion would then silently never see its input. Inside
# qufox-backup the prod env already exports DATABASE_URL.
: "${DATABASE_URL:?DATABASE_URL required (run from inside qufox-backup or export explicitly)}"

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}"

STAMP=$(date -u +%s)
# The qufox-api creds can list/put within qufox-attachments but cannot
# create buckets. Re-use the live bucket under a fixture prefix and
# clean it up at the end so we don't pollute prod with orphans.
: "${S3_BUCKET:=qufox-attachments}"
FIXTURE_PREFIX="__pagination-test-${STAMP}__"
WS_ID="00000000-0000-4000-8000-000000000000"
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"; aws --endpoint-url "$S3_ENDPOINT" s3 rm --recursive "s3://${S3_BUCKET}/${FIXTURE_PREFIX}/" >/dev/null 2>&1 || true' EXIT

echo "[fixture] uploading 1500 emoji-shaped objects under prefix ${FIXTURE_PREFIX}/ (~30s)"
SEED_FILE="$TMPROOT/dummy.bin"
printf 'qufox-orphan-gc-fixture' > "$SEED_FILE"

python3 -c "
import uuid
for i in range(1500):
    eid = str(uuid.UUID(int=(0x4000 << 112) | i))
    print(f'${FIXTURE_PREFIX}/${WS_ID}/emojis/{eid}-fixture.png')
" | while read -r KEY; do
  aws --endpoint-url "$S3_ENDPOINT" s3 cp "$SEED_FILE" "s3://${S3_BUCKET}/${KEY}" --quiet
done

echo "[fixture] objects uploaded — counting"
COUNT=$(aws --endpoint-url "$S3_ENDPOINT" s3 ls --recursive \
          "s3://${S3_BUCKET}/${FIXTURE_PREFIX}/" | wc -l)
echo "[fixture] s3 ls --recursive sees $COUNT objects under fixture prefix"

echo "[fixture] running orphan-gc.sh dry-run against bucket=${S3_BUCKET}"
SCRIPT="$(dirname "$0")/../attachment-orphan-gc.sh"
S3_BUCKET="${S3_BUCKET}" bash "$SCRIPT" --dry-run 2>&1 | tee "$TMPROOT/dry-run.log"

# The emoji sweep prints `emoji dry-run: scanned=N would-delete=M
# prefix=emojis/`. The scanned count must be >= 1500 — that proves
# the ContinuationToken loop walked past the 1000-key default page.
SCANNED=$(grep -oE 'emoji dry-run: scanned=[0-9]+' "$TMPROOT/dry-run.log" | tail -1 | sed 's/.*=//')
if [[ -z "$SCANNED" || "$SCANNED" -lt 1500 ]]; then
  echo "FAIL: pagination missed objects — scanned=${SCANNED:-?} expected>=1500"
  exit 1
fi
echo "[fixture] PASS — scanned=$SCANNED >= 1500"
