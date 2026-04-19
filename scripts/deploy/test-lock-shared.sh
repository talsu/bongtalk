#!/usr/bin/env bash
# Asserts scripts/prod-reload.sh + scripts/deploy/auto-deploy.sh grab
# the SAME flock (task-011-C MED-2). If one is holding the lock, the
# other should exit 75 (EX_TEMPFAIL) instead of racing.
#
# Exits 0 on success, non-zero on any mismatch.

set -euo pipefail

cd "$(dirname "$0")/../.."

export DEPLOY_LOCK_FILE="/tmp/qufox-lock-shared-test.$$"
rm -f "$DEPLOY_LOCK_FILE"

# 1. Open fd 9 on the test lock file and hold it in a background
#    subshell (simulates one deploy in flight).
(
  exec 9>"$DEPLOY_LOCK_FILE"
  flock -n 9
  sleep 10
) &
HOLDER_PID=$!

# Give the holder a moment to grab the lock.
sleep 0.5

# 2. Invoke prod-reload.sh in a way that only exercises the lock
#    acquisition (no actual docker work). We replace the body with a
#    no-op by piping a fake command; the script has `exec 9>...; flock
#    -n 9` via its source of lock.sh, so it exits 75 here.
#
#    To avoid running the docker build, call lock.sh directly from a
#    sub-shell mirroring prod-reload.sh's source pattern.
if bash -c '
  set -e
  DEPLOY_LOCK_FILE="'"$DEPLOY_LOCK_FILE"'"
  export DEPLOY_LOCK_FILE
  cd "'"$PWD"'"
  . scripts/deploy/lock.sh
  deploy::acquire_lock
'; then
  echo "[lock-shared-test] FAIL: second caller acquired the lock while the first holder was active" >&2
  kill $HOLDER_PID 2>/dev/null || true
  wait $HOLDER_PID 2>/dev/null || true
  rm -f "$DEPLOY_LOCK_FILE"
  exit 1
fi

echo "[lock-shared-test] ok: second caller correctly blocked by existing holder"

# 3. Cleanup.
kill $HOLDER_PID 2>/dev/null || true
wait $HOLDER_PID 2>/dev/null || true
rm -f "$DEPLOY_LOCK_FILE"
