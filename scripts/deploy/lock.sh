#!/usr/bin/env bash
# Source-this library. Wraps flock(1) around a critical section so two
# deploys (webhook + manual `prod-reload.sh`) never race on the same
# compose stack. Synology ships `flock` via util-linux in the
# webhook image and on the host (/usr/bin/flock in Entware).

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
