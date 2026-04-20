#!/usr/bin/env bash
# Cheap CI-safe check that every deploy + backup shell script parses.
# Shells out to `bash -n` so the tests have zero external dependencies
# (no docker, no postgres, no redis — the restore smoke test lives in
# restore-test.sh itself and runs against real backups).
set -euo pipefail

cd "$(dirname "$0")/../.."

fail=0
for f in scripts/deploy/*.sh scripts/backup/*.sh scripts/setup/*.sh scripts/workers/*.sh services/backup/entrypoint.sh; do
  if [[ -f "$f" ]] && ! bash -n "$f"; then
    echo "✗ $f" >&2
    fail=1
  fi
done

if [[ $fail -eq 0 ]]; then
  echo "ok: all deploy/backup scripts parse"
fi
exit $fail
