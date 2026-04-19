#!/usr/bin/env bash
# Initialize the qufox MinIO instance:
#   1. wait for the server to be ready
#   2. create the `qufox-attachments` bucket (if missing)
#   3. set bucket policy to PRIVATE (all access via presign)
#   4. create the app-scoped `qufox-api` IAM user + policy (if missing)
#   5. print the access-key / secret-key for paste into .env.prod
#
# Idempotent: rerunning after a successful install is a no-op. --dry-run
# walks the same steps without invoking mc.
#
# Requires the `qufox-minio` container to already be running. Reads
# MINIO_ROOT_USER / MINIO_ROOT_PASSWORD from .env.prod. The
# app-scoped credentials are written to stdout; the operator copies
# them into S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY in .env.prod.

set -euo pipefail

DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '1,20p' "$0" | tail -14; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/../.."

log() { printf '[init-minio] %s\n' "$*"; }

if [[ ! -f .env.prod ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log ".env.prod not found — dry-run continues with placeholder values"
    MINIO_ROOT_USER="${MINIO_ROOT_USER:-placeholder-dry-run-root}"
    MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-placeholder-dry-run-pass}"
  else
    echo "[init-minio] .env.prod not found — create it first" >&2
    exit 3
  fi
else
  # shellcheck disable=SC1091
  set -a; . .env.prod; set +a
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  : "${MINIO_ROOT_USER:?MINIO_ROOT_USER missing from .env.prod}"
  : "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD missing from .env.prod}"
fi

BUCKET="${S3_BUCKET:-qufox-attachments}"
APP_USER="${S3_ACCESS_KEY_ID:-qufox-api}"
# If .env.prod has a placeholder (change-me-*) treat it as unset and
# regenerate. The operator pastes the printed value back in; we never
# write to .env.prod from a script.
if [[ -z "${S3_SECRET_ACCESS_KEY:-}" || "${S3_SECRET_ACCESS_KEY:-}" == change-me* ]]; then
  APP_SECRET="$(openssl rand -hex 20)"
  GENERATED_SECRET=1
else
  APP_SECRET="$S3_SECRET_ACCESS_KEY"
  GENERATED_SECRET=0
fi

# Policy: the app user can read, write, delete, and list its single
# bucket. No s3:CreateBucket, no admin surface, no multi-bucket access.
POLICY_JSON=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::${BUCKET}/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": ["arn:aws:s3:::${BUCKET}"]
    }
  ]
}
JSON
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "--dry-run:"
  log "  would wait for qufox-minio to be reachable at http://qufox-minio:9000/minio/health/live"
  log "  would create bucket: $BUCKET (no-op if present)"
  log "  would set bucket policy: none (presign-only)"
  log "  would create IAM user: $APP_USER"
  log "  would attach inline policy to $APP_USER for bucket $BUCKET (s3:GetObject/PutObject/DeleteObject/ListBucket/GetBucketLocation)"
  if [[ "$GENERATED_SECRET" -eq 1 ]]; then
    log "  would print a FRESH app secret (not persisted): $APP_SECRET"
  else
    log "  would reuse existing app secret from .env.prod (not printed)"
  fi
  exit 0
fi

# All mc commands run inside a throwaway container on the `internal`
# network so we don't have to install mc on the host. --rm + fresh
# alias each call keeps it stateless.
mc() {
  docker run --rm --network internal \
    -e MC_HOST_qufox="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@qufox-minio:9000" \
    minio/mc:RELEASE.2024-09-09T16-17-43Z "$@"
}

log "waiting for qufox-minio to be reachable…"
deadline=$(( $(date +%s) + 60 ))
while [[ $(date +%s) -lt $deadline ]]; do
  if mc alias ls qufox >/dev/null 2>&1; then
    log "qufox-minio is ready"
    break
  fi
  sleep 2
done

log "ensure bucket exists: $BUCKET"
mc mb --ignore-existing qufox/"$BUCKET"

log "ensure bucket policy is none (presign-only access)"
mc anonymous set none qufox/"$BUCKET" 2>/dev/null || true

log "ensure IAM user exists: $APP_USER"
if mc admin user info qufox "$APP_USER" >/dev/null 2>&1; then
  log "  user already present — skipping create (secret unchanged)"
else
  mc admin user add qufox "$APP_USER" "$APP_SECRET"
fi

log "attach inline policy for $APP_USER → $BUCKET"
# Task-012 reviewer HIGH-2 fix: the mc container is a throwaway
# sibling of qufox-minio, NOT the server itself. `docker cp` into
# qufox-minio doesn't help — mc needs the file visible INSIDE ITS OWN
# container. Mount the host-local tempfile read-only at /tmp/policy.json
# and point mc at that path. The previous version swallowed both the
# create and attach failures with `|| true` so the script printed
# "ok" while the IAM user ended up with no policy attached →
# AccessDenied on every subsequent S3 call.
TMP_POLICY="/tmp/qufox-minio-policy-$$.json"
printf '%s\n' "$POLICY_JSON" > "$TMP_POLICY"
chmod 0644 "$TMP_POLICY"
mc_with_policy() {
  docker run --rm --network internal \
    -e MC_HOST_qufox="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@qufox-minio:9000" \
    -v "$TMP_POLICY:/tmp/policy.json:ro" \
    minio/mc:RELEASE.2024-09-09T16-17-43Z "$@"
}
# Idempotent via an explicit info check rather than the failure-
# swallowing `|| true` pattern the reviewer flagged.
if mc admin policy info qufox qufox-api-policy >/dev/null 2>&1; then
  log "  policy qufox-api-policy already exists — skipping create"
else
  mc_with_policy admin policy create qufox qufox-api-policy /tmp/policy.json
fi
# `attach` is natively idempotent; the 2>/dev/null keeps the "already
# attached" message quiet on re-runs.
mc admin policy attach qufox qufox-api-policy --user "$APP_USER" 2>/dev/null || \
  log "  policy already attached to $APP_USER (or attach no-op)"
rm -f "$TMP_POLICY"

log "ok — MinIO ready"

if [[ "$GENERATED_SECRET" -eq 1 ]]; then
  echo
  echo "╭──────────────────────────────────────────────────────────────╮"
  echo "│  PASTE THESE INTO .env.prod (S3_* section)                    │"
  echo "│                                                              │"
  echo "│  S3_ACCESS_KEY_ID=$APP_USER                                   "
  echo "│  S3_SECRET_ACCESS_KEY=$APP_SECRET                             "
  echo "│                                                              │"
  echo "│  After pasting, restart qufox-api so the SDK picks them up.  │"
  echo "╰──────────────────────────────────────────────────────────────╯"
fi
