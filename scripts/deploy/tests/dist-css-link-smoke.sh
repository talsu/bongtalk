#!/usr/bin/env bash
# task-029-D regression guard. Builds apps/web and asserts dist/index.html
# links all four DS stylesheets: tokens + components + mobile + icons.
# Surfaces the 029 root cause (mobile.css drop-out) at CI time instead
# of in the user's browser.

set -euo pipefail

REPO_ROOT=${REPO_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}
cd "$REPO_ROOT"

echo "[ds-smoke] building @qufox/web …"
pnpm --filter @qufox/web build >/dev/null

DIST_HTML="apps/web/dist/index.html"
if [ ! -f "$DIST_HTML" ]; then
  echo "[ds-smoke] FAIL: $DIST_HTML not produced"
  exit 1
fi

missing=0
for css in tokens.css components.css mobile.css icons.css; do
  if grep -q "/design-system/${css}" "$DIST_HTML"; then
    echo "[ds-smoke] ok   ${css}"
  else
    echo "[ds-smoke] MISS ${css} — <link rel=\"stylesheet\" href=\"/design-system/${css}\"> absent"
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "[ds-smoke] FAIL: one or more DS stylesheets missing from dist/index.html"
  exit 1
fi

echo "[ds-smoke] OK — all 4 DS stylesheets linked in dist/index.html"
