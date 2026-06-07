#!/usr/bin/env bash
# Manual rebuild + redeploy of qufox production services — the operator's
# break-glass escape hatch. Mirrors the automated path: build in the isolated
# qufox-builder, push to the local registry, then pull-based rollout with
# health-gated rollback. The production daemon never builds (pillar A).
#
# Usage:
#   scripts/prod-reload.sh                 # rebuild + roll out api & web
#   scripts/prod-reload.sh api             # only api
#   scripts/prod-reload.sh web             # only web
#   scripts/prod-reload.sh --force         # skip the shared flock (break-glass)
#   scripts/prod-reload.sh --force api     # combined
#
# NOTE: this does NOT run db migrations (it's a code/image reload). For a
# deploy that includes schema changes use scripts/deploy/auto-deploy.sh,
# which runs the one-shot `prisma migrate deploy` before rollout.
#
# --force is for when the webhook died holding the flock (no EXIT trap fired,
# e.g. SIGKILL). An audit line records the bypass.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"

FORCE=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

# Share the webhook's flock so a manual reload and an auto-deploy never race.
# shellcheck source=./deploy/lock.sh
. "$REPO/scripts/deploy/lock.sh"
if [[ "$FORCE" -eq 1 ]]; then
  mkdir -p .deploy
  printf '{"ts":"%s","event":"manual.force-unlock","source":"prod-reload.sh"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .deploy/audit.jsonl
  echo "[prod-reload] --force: bypassing deploy lock; audit line written" >&2
else
  deploy::acquire_lock || exit $?
  trap 'deploy::release_lock' EXIT
fi

TARGET="${ARGS[0]:-all}"
case "$TARGET" in
  api)    SVC=(api) ;;
  web)    SVC=(web) ;;
  all|"") SVC=(api web) ;;
  *) echo "unknown target: $TARGET (expected: api | web | all)"; exit 2 ;;
esac

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo manual)"

for svc in "${SVC[@]}"; do
  echo "==> build+push: $svc (sha=$SHA)"
  bash "$REPO/scripts/deploy/build-and-push.sh" "$svc" "$SHA"
  echo "==> rollout: $svc"
  bash "$REPO/scripts/deploy/rollout.sh" "$svc"
done

echo "==> done"
