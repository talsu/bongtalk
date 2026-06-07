#!/usr/bin/env bash
# Full production deploy, triggered by the webhook service (or run by hand).
# REWRITTEN for the safe-deploy redesign — the production daemon NEVER builds.
#
# Pipeline:
#   lock → breaker gate → fetch/checkout → build+push api,web (isolated
#   builder → local registry) → one-shot prisma migrate → deploy-hook SQL →
#   rollout api (pull+up+health, rollback on fail) → rollout web → smoke →
#   record breaker result → post-deploy prune.
#
# WHY each guard exists: see scripts/deploy/build-and-push.sh (pillar A,
# build isolation), scripts/deploy/breaker.sh (pillar B, retry-loop cap),
# apps/api/Dockerfile (pillar C, no boot-time migrate), and
# scripts/ops/btrfs-watchdog.sh + the prune step below (pillar D).
#
# Environment (provided by services/webhook via process env):
#   DEPLOY_SHA / DEPLOY_BRANCH / DEPLOY_PUSHER / REPO_PATH
#
# Exit codes:
#   0  success
#  70  breaker OPEN — deploy refused (run reset-breaker.sh after a fix)
#  75  could not acquire deploy lock (another deploy active)
#   1  build / migration / rollout failure (rolled back; breaker incremented)
#   2  unrecoverable (e.g. git fetch failed)
set -euo pipefail

REPO="${REPO_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$REPO"

# Mark the bind-mounted repo safe for git (webhook runs as root over an
# admin-owned tree); scoped to this repo only.
git config --global --add safe.directory "$REPO" 2>/dev/null || true
# Redirect OpenSSH known_hosts writes to tmpfs (deploy-key dir is mounted :ro).
export GIT_SSH_COMMAND="ssh -o UserKnownHostsFile=/tmp/known_hosts -o StrictHostKeyChecking=yes"

# shellcheck source=/volume2/dockers/qufox/scripts/deploy/lock.sh
. "$REPO/scripts/deploy/lock.sh"
# shellcheck source=/volume2/dockers/qufox/scripts/deploy/breaker.sh
. "$REPO/scripts/deploy/breaker.sh"

SHA="${DEPLOY_SHA:-}"
BRANCH="${DEPLOY_BRANCH:-main}"
PUSHER="${DEPLOY_PUSHER:-unknown}"
REGISTRY="${QUFOX_REGISTRY:-localhost:5050}"

LOG_DIR="$REPO/.deploy/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/deploy-$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:7}.log"
exec > >(tee -a "$LOG_FILE") 2>&1

log() { printf '[auto-deploy] %s\n' "$*"; }

log "begin branch=$BRANCH sha=$SHA pusher=$PUSHER repo=$REPO log=$LOG_FILE"

# --- 1. concurrency lock ------------------------------------------------
deploy::acquire_lock || exit $?
trap 'deploy::release_lock' EXIT

# --- 1.5 circuit breaker gate (pillar B) --------------------------------
# Refuse to deploy a service whose breaker is open. This is what stops the
# fix-forward → rebuild → fail → repeat loop that fed the runaway.
for svc in api web; do
  if breaker::is_open "$svc"; then
    log "breaker OPEN for $svc — refusing deploy. Run: scripts/deploy/reset-breaker.sh $svc" >&2
    exit 70
  fi
done

# --- 2. fetch + checkout ------------------------------------------------
if [[ -n "$SHA" ]]; then
  log "git fetch origin $BRANCH"
  git fetch --quiet origin "$BRANCH" || { log "git fetch failed" >&2; exit 2; }
  log "git checkout --force $SHA"
  git checkout --force --quiet "$SHA" || { log "git checkout failed" >&2; exit 2; }
else
  log "no DEPLOY_SHA provided — building current checkout"
fi

SHA_ARG="${SHA:-manual}"

# --- 3. build + push images in the ISOLATED builder (pillar A) ----------
# build-and-push.sh also preserves the current :latest as :prev for rollback.
for svc in api web; do
  log "build+push $svc (isolated builder → $REGISTRY)"
  if ! bash "$REPO/scripts/deploy/build-and-push.sh" "$svc" "$SHA_ARG"; then
    log "build+push $svc FAILED — aborting (previous containers still serving)" >&2
    breaker::record_failure "$svc"
    exit 1
  fi
done

# --- 4. one-shot db migration with the NEW api image (pillar C) ---------
# Migrations no longer run on container boot. Pull the freshly-built api
# image and run `prisma migrate deploy` exactly once here; on failure the
# currently-running containers keep serving and we abort before rollout.
COMPOSE=(docker compose -p qufox --env-file .env.prod -f docker-compose.prod.yml)
log "pull api image for migration"
"${COMPOSE[@]}" pull qufox-api
log "run prisma migrate deploy (one-shot)"
if ! "${COMPOSE[@]}" run --rm --entrypoint prisma qufox-api \
      migrate deploy --schema=prisma/schema.prisma; then
  log "migration failed — aborting deploy (previous containers still serving)" >&2
  breaker::record_failure api
  exit 1
fi

# --- 4.5 deploy-hook SQL (non-transactional DDL) ------------------------
# Each file must be idempotent (IF NOT EXISTS / IF EXISTS). Run via docker cp
# + `psql -f` wrapped in `timeout` (the stdin-redirect form could hang after
# psql finished and wedge the flock — see git history for the S73 incident).
HOOK_DIR="$REPO/scripts/deploy/sql"
HOOKS=()
for f in "$HOOK_DIR"/*.sql; do [[ -e "$f" ]] && HOOKS+=("$f"); done
HOOK_TIMEOUT="${DEPLOY_HOOK_TIMEOUT:-600}"
if [[ "${#HOOKS[@]}" -gt 0 ]]; then
  for f in "${HOOKS[@]}"; do
    base="$(basename "$f")"
    log "deploy-hook SQL: $base"
    if ! docker cp "$f" qufox-postgres-prod:/tmp/qufox-deploy-hook.sql; then
      log "deploy-hook SQL copy failed: $base — aborting" >&2; breaker::record_failure api; exit 1
    fi
    rc=0
    timeout "$HOOK_TIMEOUT" docker exec qufox-postgres-prod \
      sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U qufox -d qufox -f /tmp/qufox-deploy-hook.sql' \
      || rc=$?
    docker exec qufox-postgres-prod rm -f /tmp/qufox-deploy-hook.sql 2>/dev/null || true
    if [[ "$rc" -ne 0 ]]; then
      [[ "$rc" -eq 124 ]] && log "deploy-hook SQL timed out after ${HOOK_TIMEOUT}s: $base — aborting" >&2 \
                          || log "deploy-hook SQL failed (rc=$rc): $base — aborting" >&2
      breaker::record_failure api; exit 1
    fi
  done
else
  log "no deploy-hook SQL to run"
fi

# --- 5. rollout each service (pull + up + health, rollback on fail) ------
log "rollout api"
if ! bash "$REPO/scripts/deploy/rollout.sh" api; then
  log "api rollout failed — already rolled back by rollout.sh" >&2
  breaker::record_failure api
  exit 1
fi

log "rollout web"
if ! bash "$REPO/scripts/deploy/rollout.sh" web; then
  log "web rollout failed — already rolled back by rollout.sh" >&2
  log "note: api swapped OK; web is now pointing at :prev web" >&2
  breaker::record_failure web
  exit 1
fi

# --- 6. post-deploy smoke (cheap) --------------------------------------
log "post-deploy smoke"
curl -skf "${API_HEALTH_URL:-https://qufox.com/api/healthz}" >/dev/null && log "  api smoke OK"
curl -skf "${WEB_HEALTH_URL:-https://qufox.com/}" -o /dev/null && log "  web smoke OK"

# --- 7. record success (closes breaker, stamps sha) --------------------
breaker::record_success api "$SHA_ARG"
breaker::record_success web "$SHA_ARG"

# --- 8. post-deploy prune (pillar D) -----------------------------------
# Reclaim host graph (dangling pulled layers) and trim old registry sha-tags.
# Build-cache pruning already happened inside build-and-push.sh.
log "post-deploy prune"
docker image prune -f >/dev/null 2>&1 || true
[ "$SHA_ARG" != manual ] && bash "$REPO/scripts/deploy/registry-gc.sh" "${SHA_ARG:0:7}" >/dev/null 2>&1 || true

log "deploy done sha=$SHA"
exit 0
