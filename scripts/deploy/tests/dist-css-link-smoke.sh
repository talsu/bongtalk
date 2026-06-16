#!/usr/bin/env bash
# DS direct-reference guard. Builds apps/web and asserts dist/index.html
# links the design.qufox.com DS stylesheets (rolling latest, SSOT) — and
# does NOT regress back to a stale local /design-system/*.css copy.
# Replaces the old local-link guard (task-029) after the DS moved to
# design.qufox.com.

set -euo pipefail

REPO_ROOT=${REPO_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}
cd "$REPO_ROOT"

CDN="https://design.qufox.com"

echo "[ds-smoke] building @qufox/web …"
pnpm --filter @qufox/web build >/dev/null

DIST_HTML="apps/web/dist/index.html"
if [ ! -f "$DIST_HTML" ]; then
  echo "[ds-smoke] FAIL: $DIST_HTML not produced"
  exit 1
fi

missing=0
for css in tokens.css components.css mobile.css icons.css; do
  if grep -q "${CDN}/${css}" "$DIST_HTML"; then
    echo "[ds-smoke] ok   ${css} → ${CDN}/${css}"
  else
    echo "[ds-smoke] MISS ${css} — <link href=\"${CDN}/${css}\"> absent from dist/index.html"
    missing=1
  fi
done

# Guard against a stale local CSS copy creeping back in (icons.svg is the
# one intentional local exception — cross-origin SVG <use> is browser-blocked —
# and is .svg, so it does not match this .css check).
if grep -qE 'href="/design-system/[a-z-]+\.css"' "$DIST_HTML"; then
  echo "[ds-smoke] FAIL: dist/index.html still links a local /design-system/*.css (must use ${CDN})"
  missing=1
fi

if [ "$missing" -ne 0 ]; then
  echo "[ds-smoke] FAIL: DS stylesheet links not pointing at ${CDN}"
  exit 1
fi

# Informational: SSOT reachability (does not hard-fail on transient network).
for css in tokens.css components.css; do
  code=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "${CDN}/${css}" 2>/dev/null || echo "000")
  echo "[ds-smoke] reachability ${CDN}/${css} -> ${code}"
done

echo "[ds-smoke] OK — DS stylesheets linked from ${CDN} in dist/index.html"
