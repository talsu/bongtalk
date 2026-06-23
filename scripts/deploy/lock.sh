#!/usr/bin/env bash
# Source-this library. Wraps flock(1) around a critical section so two
# concurrent `deploy.sh` runs never race on the same compose stack
# (webhook/prod-reload.sh were removed in task-076; deploy.sh is the single
# entry point). Synology ships `flock` via util-linux on the host
# (/usr/bin/flock in Entware).

set -euo pipefail

DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-${REPO_PATH:-/volume2/dockers/qufox}/.deploy/deploy.lock}"

deploy::acquire_lock() {
  mkdir -p "$(dirname "$DEPLOY_LOCK_FILE")"
  # File descriptor 9 is reserved for the lock; `flock -n` fails fast if
  # someone else holds it. Caller typically wraps the whole deploy in
  # `(deploy::acquire_lock; real_work) 9>"$DEPLOY_LOCK_FILE"`.
  exec 9>"$DEPLOY_LOCK_FILE"
  if ! flock -n 9; then
    echo "deploy already in progress (lock: $DEPLOY_LOCK_FILE)" >&2
    return 75  # EX_TEMPFAIL — caller maps to HTTP 429
  fi
}

deploy::release_lock() {
  exec 9>&-
}
