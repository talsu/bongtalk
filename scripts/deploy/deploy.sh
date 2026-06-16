#!/usr/bin/env bash
# qufox production deploy — local, operator/AI-run single entry point.
# Replaces auto-deploy.sh + prod-reload.sh after the GitHub webhook was
# removed (task-076). No daemon, no remote trigger: a person/agent runs this.
#
# The production daemon NEVER builds (pillar A): images are built in the
# isolated qufox-builder and pushed to the local registry (localhost:5050),
# then pulled. Rollout is health-gated with :prev auto-rollback (pillar A
# safety preserved). Migrations run once, before rollout (pillar C).
#
# Usage:
#   scripts/deploy/deploy.sh                  # build + migrate + rollout api & web (current HEAD)
#   scripts/deploy/deploy.sh --service web    # only web (web-only implies --no-migrate)
#   scripts/deploy/deploy.sh --no-migrate     # code/image reload, skip prisma migrate
#   scripts/deploy/deploy.sh --sha <commit>   # fetch + checkout a specific commit first
#   scripts/deploy/deploy.sh --check          # pre-flight only (space + last-result), no deploy
#   scripts/deploy/deploy.sh --force          # bypass the post-failure / space guard (audited; still locks)
#
# Lightweight guard (replaces the old circuit breaker; tuned for AI-run
# deploys so a bad build can't be re-pushed in a blind loop): refuses if
#   (a) btrfs metadata space is CRITICAL (btrfs-watchdog exit 2), or
#   (b) the previous deploy FAILED and --force was not given.
# Health-gate + :prev rollback are ALWAYS on, so a bad deploy self-heals.
#
# Exit: 0 ok · 1 build/migrate/rollout failure (rolled back) · 2 usage/git ·
#       70 guard refused · 75 another deploy holds the lock
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
git config --global --add safe.directory "$REPO" 2>/dev/null || true
export GIT_SSH_COMMAND="ssh -o UserKnownHostsFile=/tmp/known_hosts -o StrictHostKeyChecking=yes"

# shellcheck source=./lock.sh
. "$REPO/scripts/deploy/lock.sh"

# ---- args ----------------------------------------------------------------
SERVICE=all; MIGRATE=1; FORCE=0; CHECK=0; SHA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="${2:?--service needs a value}"; shift 2 ;;
    --service=*) SERVICE="${1#*=}"; shift ;;
    --no-migrate) MIGRATE=0; shift ;;
    --migrate) MIGRATE=1; shift ;;
    --sha) SHA="${2:?--sha needs a value}"; shift 2 ;;
    --sha=*) SHA="${1#*=}"; shift ;;
    --force) FORCE=1; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (see --help)" >&2; exit 2 ;;
  esac
done
case "$SERVICE" in
  api) SVC=(api) ;;
  web) SVC=(web); MIGRATE=0 ;;   # web-only never needs a schema migration
  all) SVC=(api web) ;;
  *) echo "bad --service: $SERVICE (api|web|all)" >&2; exit 2 ;;
esac

REGISTRY="${QUFOX_REGISTRY:-localhost:5050}"
DEPLOY_DIR="$REPO/.deploy"
RESULT_FILE="$DEPLOY_DIR/last-result"
mkdir -p "$DEPLOY_DIR/logs"
LOG_FILE="$DEPLOY_DIR/logs/deploy-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG_FILE") 2>&1

log() { printf '[deploy] %s\n' "$*"; }
audit() { printf '{"ts":"%s","event":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$DEPLOY_DIR/audit.jsonl"; }
record() { # result sha
  printf '{"result":"%s","sha":"%s","service":"%s","ts":"%s"}\n' \
    "$1" "$2" "$SERVICE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RESULT_FILE"
  audit "{\"deploy\":\"$1\",\"sha\":\"$2\",\"service\":\"$SERVICE\"}"
}

# ---- lightweight guard (replaces circuit breaker) ------------------------
guard() {
  local wd="$REPO/scripts/ops/btrfs-watchdog.sh"
  if [[ -x "$wd" || -f "$wd" ]]; then
    local rc=0; bash "$wd" /volume2 || rc=$?
    if [[ "$rc" -eq 2 ]]; then
      if [[ "$FORCE" -eq 1 ]]; then log "GUARD: btrfs CRIT but --force given — proceeding.";
      else log "GUARD: btrfs metadata space CRITICAL — refusing. Reclaim space, then --force." >&2; return 70; fi
    fi
  fi
  if [[ -f "$RESULT_FILE" ]] && grep -q '"result":"fail"' "$RESULT_FILE" 2>/dev/null; then
    if [[ "$FORCE" -eq 1 ]]; then log "GUARD: last deploy FAILED; --force given — proceeding.";
    else log "GUARD: last deploy FAILED ($(cat "$RESULT_FILE")). Investigate, then re-run with --force." >&2; return 70; fi
  fi
  return 0
}

log "begin service=$SERVICE migrate=$MIGRATE force=$FORCE sha=${SHA:-HEAD} repo=$REPO"
guard || exit $?
[[ "$CHECK" -eq 1 ]] && { log "pre-flight OK (--check) — not deploying."; exit 0; }

# ---- concurrency lock (ALWAYS — --force bypasses the guard, never mutual
# exclusion: a wedged deploy holding the flock would otherwise be raced. A
# flock from a dead process auto-releases when its fd closes.) -------------
deploy::acquire_lock || exit $?
trap 'deploy::release_lock' EXIT
[[ "$FORCE" -eq 1 ]] && audit '"deploy.force-guard-bypass"'

# ---- optional checkout ---------------------------------------------------
if [[ -n "$SHA" ]]; then
  log "git fetch origin + checkout --force $SHA"
  git fetch --quiet origin || { log "git fetch failed" >&2; exit 2; }
  git checkout --force --quiet "$SHA" || { log "git checkout failed" >&2; exit 2; }
fi
SHA_TAG="$(git rev-parse --short HEAD 2>/dev/null || echo manual)"

# ---- build + push (isolated builder → registry, preserves :prev) ---------
for svc in "${SVC[@]}"; do
  log "build+push $svc (isolated builder → $REGISTRY)"
  if ! bash "$REPO/scripts/deploy/build-and-push.sh" "$svc" "$SHA_TAG"; then
    log "build+push $svc FAILED — aborting (previous containers still serving)" >&2
    record fail "$SHA_TAG"; exit 1
  fi
done

COMPOSE=(docker compose -p qufox --env-file .env.prod -f docker-compose.prod.yml)

# ---- one-shot migration (pillar C), unless --no-migrate / web-only -------
if [[ "$MIGRATE" -eq 1 ]] && printf '%s\n' "${SVC[@]}" | grep -qx api; then
  log "pull api image + prisma migrate deploy (one-shot)"
  "${COMPOSE[@]}" pull qufox-api
  if ! "${COMPOSE[@]}" run --rm --entrypoint prisma qufox-api migrate deploy --schema=prisma/schema.prisma; then
    log "migration failed — aborting (previous containers still serving)" >&2
    record fail "$SHA_TAG"; exit 1
  fi
  # deploy-hook SQL: idempotent non-transactional DDL. docker cp + psql -f
  # (not stdin-redirect, which could hang after psql exits and wedge flock — S73).
  HOOK_TIMEOUT="${DEPLOY_HOOK_TIMEOUT:-600}"
  for f in "$REPO"/scripts/deploy/sql/*.sql; do
    [[ -e "$f" ]] || continue
    base="$(basename "$f")"; log "deploy-hook SQL: $base"
    if ! docker cp "$f" qufox-postgres-prod:/tmp/qufox-deploy-hook.sql; then
      log "deploy-hook SQL copy failed: $base — aborting" >&2; record fail "$SHA_TAG"; exit 1
    fi
    rc=0
    timeout "$HOOK_TIMEOUT" docker exec qufox-postgres-prod \
      sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U qufox -d qufox -f /tmp/qufox-deploy-hook.sql' || rc=$?
    docker exec qufox-postgres-prod rm -f /tmp/qufox-deploy-hook.sql 2>/dev/null || true
    if [[ "$rc" -ne 0 ]]; then
      [[ "$rc" -eq 124 ]] && log "deploy-hook SQL timed out (${HOOK_TIMEOUT}s): $base" >&2 || log "deploy-hook SQL failed (rc=$rc): $base" >&2
      record fail "$SHA_TAG"; exit 1
    fi
  done
else
  log "skip migration (--no-migrate or api not in target)"
fi

# ---- rollout (pull + up + health-wait + :prev auto-rollback) -------------
for svc in "${SVC[@]}"; do
  log "rollout $svc"
  if ! bash "$REPO/scripts/deploy/rollout.sh" "$svc"; then
    log "$svc rollout failed — rolled back to :prev by rollout.sh" >&2
    record fail "$SHA_TAG"; exit 1
  fi
done

# ---- post-deploy smoke (cheap) ------------------------------------------
log "post-deploy smoke"
curl -skf "${API_HEALTH_URL:-https://qufox.com/api/healthz}" >/dev/null && log "  api smoke OK" || log "  api smoke: non-200 (already passed health-wait)"
curl -skf "${WEB_HEALTH_URL:-https://qufox.com/}" -o /dev/null && log "  web smoke OK" || log "  web smoke: non-200"

record ok "$SHA_TAG"
log "post-deploy prune (dangling host layers)"
docker image prune -f >/dev/null 2>&1 || true
log "deploy done sha=$SHA_TAG service=$SERVICE"
exit 0
