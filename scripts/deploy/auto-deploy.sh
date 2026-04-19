#!/usr/bin/env bash
# Full production deploy, triggered by the webhook service. Reuses the
# same compose file + env file as the manual scripts/prod-reload.sh so
# the two paths are interchangeable (manual stays as an escape hatch).
#
# Environment (provided by services/webhook via process env):
#   DEPLOY_SHA      — commit SHA being deployed (optional, used for tags)
#   DEPLOY_BRANCH   — branch name (for logs / notifications)
#   DEPLOY_PUSHER   — GitHub username that triggered the push
#   REPO_PATH       — absolute path to the repo on disk
#
# Exit codes:
#   0  success
#  75  could not acquire deploy lock (another deploy is active)
#   1  rollout or migration failure (already rolled back)
#   2  unrecoverable (e.g. git fetch failed)

set -euo pipefail

REPO="${REPO_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$REPO"

# shellcheck source=/volume2/dockers/qufox/scripts/deploy/lock.sh
. "$REPO/scripts/deploy/lock.sh"

SHA="${DEPLOY_SHA:-}"
BRANCH="${DEPLOY_BRANCH:-main}"
PUSHER="${DEPLOY_PUSHER:-unknown}"

LOG_DIR="$REPO/.deploy/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/deploy-$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:7}.log"
exec > >(tee -a "$LOG_FILE") 2>&1

log() { printf '[auto-deploy] %s\n' "$*"; }

log "begin branch=$BRANCH sha=$SHA pusher=$PUSHER repo=$REPO log=$LOG_FILE"

# --- 1. concurrency lock ------------------------------------------------
deploy::acquire_lock || exit $?
trap 'deploy::release_lock' EXIT

# --- 2. fetch + checkout ------------------------------------------------
if [[ -n "$SHA" ]]; then
  log "git fetch origin $BRANCH"
  git fetch --quiet origin "$BRANCH" || { log "git fetch failed" >&2; exit 2; }
  log "git checkout --force $SHA"
  git checkout --force --quiet "$SHA" || { log "git checkout failed" >&2; exit 2; }
else
  log "no DEPLOY_SHA provided — building current checkout"
fi

# --- 3. db migrations (fail-abort keeps previous containers serving) ---
#
# DATABASE_URL is NOT overridden here: the qufox-api service in
# docker-compose.prod.yml already defines it with $POSTGRES_PASSWORD
# interpolated by compose itself (from --env-file .env.prod). The
# previous shell-expansion override was broken because this script runs
# inside the webhook container whose env comes from .env.deploy, so the
# password was empty and every migration authentication-failed.
log "run prisma migrate deploy"
if ! docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm \
      qufox-api pnpm --filter @qufox/api db:migrate; then
  log "migration failed — aborting deploy (previous containers still serving)" >&2
  exit 1
fi

# --- 4. rollout each service (each rolls back on its own health fail) --
log "rollout api"
if ! bash "$REPO/scripts/deploy/rollout.sh" api; then
  log "api rollout failed — already rolled back by rollout.sh" >&2
  exit 1
fi

log "rollout web"
if ! bash "$REPO/scripts/deploy/rollout.sh" web; then
  log "web rollout failed — already rolled back by rollout.sh" >&2
  log "note: api was swapped successfully, web is now pointing at :prev web" >&2
  exit 1
fi

# --- 5. post-deploy smoke (cheap) --------------------------------------
log "post-deploy smoke"
curl -skf "${API_HEALTH_URL:-https://qufox.com/api/healthz}" >/dev/null && log "  api smoke OK"
curl -skf "${WEB_HEALTH_URL:-https://qufox.com/}" -o /dev/null && log "  web smoke OK"

# --- 6. gc old :sha-* tags ---------------------------------------------
# Keep newest $KEEP :sha-* tags; prune the rest. `docker image ls` sorted
# by CreatedAt DESC via the format string ensures the newest are first,
# then `tail -n +$((KEEP+1))` drops the first $KEEP rows and emits the
# rest (which are the older ones we want to prune). Busybox tail supports
# `+N` so the pipeline works on alpine without coreutils.
KEEP="${IMAGE_HISTORY_KEEP:-10}"
for img in qufox/api qufox/web; do
  mapfile -t stale < <(docker image ls --format '{{.CreatedAt}}\t{{.Tag}}' "$img" \
    | awk '$2 ~ /^sha-/' \
    | sort -r \
    | awk '{print $2}' \
    | tail -n +$((KEEP + 1)))
  for t in "${stale[@]:-}"; do
    [[ -z "$t" ]] && continue
    log "gc $img:$t"
    docker image rm "$img:$t" >/dev/null 2>&1 || true
  done
done

log "deploy done sha=$SHA"
exit 0
