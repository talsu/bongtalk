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

# task-016 ops fix-forward: the webhook container runs as root and
# bind-mounts /volume2/dockers/qufox (admin:users on the host) as
# /repo. Git >= 2.35 refuses `git fetch` inside such a tree unless
# the path is explicitly marked safe (the "dubious ownership" error).
# Mark it here at the top of the deploy so the setting survives
# across the fetch/checkout block below. Scoped to this repo only.
git config --global --add safe.directory "$REPO" 2>/dev/null || true

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
# Runtime image ships a global `prisma` CLI but NO `pnpm` (prod-only
# slim). The earlier `pnpm --filter @qufox/api db:migrate` call was a
# dev shape that crashed with "No such file or directory" on a real
# webhook deploy. Overriding the entrypoint sidesteps the CMD's
# `prisma migrate deploy && node dist/main.js` — we want only the
# migrate half here, and node startup follows during the rollout.
if ! docker compose -p qufox --env-file .env.prod -f docker-compose.prod.yml run --rm \
      --entrypoint prisma qufox-api migrate deploy --schema=prisma/schema.prisma; then
  log "migration failed — aborting deploy (previous containers still serving)" >&2
  exit 1
fi

# --- 3.5 deploy-hook SQL (task-016-A) ----------------------------------
# Non-transactional DDL (CREATE INDEX CONCURRENTLY, REINDEX …) that
# Prisma's transactional migrations can't host. Each file is expected
# to be idempotent — `IF NOT EXISTS` for creates, `IF EXISTS` for
# drops. Alphabetical run order means a new hook lands by file-drop,
# no registration step. Failure aborts the deploy BEFORE the rollout;
# `ON_ERROR_STOP=1` makes psql exit non-zero on the first SQL error so
# we don't silently skip the rest. See docs/ops/runbook-deploy.md for
# when to add a hook and what "idempotent" means in this context.
HOOK_DIR="$REPO/scripts/deploy/sql"
HOOKS=()
for f in "$HOOK_DIR"/*.sql; do
  [[ -e "$f" ]] && HOOKS+=("$f")
done
if [[ "${#HOOKS[@]}" -gt 0 ]]; then
  for f in "${HOOKS[@]}"; do
    log "deploy-hook SQL: $(basename "$f")"
    if ! docker compose -p qufox --env-file .env.prod -f docker-compose.prod.yml exec -T \
          qufox-postgres-prod \
          sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U qufox -d qufox' \
          < "$f"; then
      log "deploy-hook SQL failed: $(basename "$f") — aborting" >&2
      exit 1
    fi
  done
else
  log "no deploy-hook SQL to run"
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
