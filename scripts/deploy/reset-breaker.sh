#!/usr/bin/env bash
# Manually reset the deploy circuit breaker after a human has confirmed the
# underlying failure is fixed. See scripts/deploy/breaker.sh for the model.
#
# Usage:
#   reset-breaker.sh <api|web|all>     # close the breaker
#   reset-breaker.sh --status          # print current breaker state
set -euo pipefail

cd "${REPO_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
# shellcheck source=./breaker.sh
. "$(dirname "$0")/breaker.sh"

case "${1:-}" in
  --status|status|'')
    breaker::status
    ;;
  api|web|all)
    breaker::reset "$1"
    echo "--- state now ---"
    breaker::status
    ;;
  *)
    echo "usage: reset-breaker.sh <api|web|all|--status>" >&2
    exit 2
    ;;
esac
