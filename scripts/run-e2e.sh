#!/usr/bin/env bash
# Run Playwright tests inside the official Playwright docker image so we do not
# depend on host glibc / browser installs (Synology kernel 4.4 friendly).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="mcr.microsoft.com/playwright:v1.48.2-jammy"
BASE_URL="${PLAYWRIGHT_BASE_URL:-http://localhost:5173}"

echo "[e2e] base URL: $BASE_URL"
echo "[e2e] container: $IMAGE"

docker run --rm \
  --network host \
  -v "$ROOT:/work" \
  -w /work/apps/web \
  -e PLAYWRIGHT_BASE_URL="$BASE_URL" \
  -e CI="${CI:-}" \
  "$IMAGE" \
  /bin/sh -c "npx --yes playwright@1.48.2 test"
