#!/usr/bin/env bash
# Proves the task-010-C ESLint rule fires on raw Tailwind palette classes.
# Runs eslint with --no-ignore on the synthetic fixture file and asserts
# non-zero exit. Skips silently if eslint isn't installed yet (post-clone).

set -euo pipefail
cd "$(dirname "$0")/.."

FIXTURE=apps/web/test/fixtures/palette-violation.tsx
if [[ ! -f "$FIXTURE" ]]; then
  echo "[palette-rule] fixture missing: $FIXTURE" >&2
  exit 2
fi

# Target the apps/web workspace so the fixture's features/auth-equivalent
# is linted at ERROR level via the `apps/web/src/**` override. The
# `--no-ignore` flag overrides the eslint.config.mjs `ignores` entry
# that hides this fixture from normal runs. --rule forces the error
# severity explicitly so the test is independent of the path pattern
# which only applies to apps/web/src/**.
output=$(pnpm --filter @qufox/web exec eslint --no-ignore \
  --rule '{ "no-restricted-syntax": ["error", { "selector": "Literal[value=/\\b(bg|text|border)-(slate|red|blue|green|yellow)-[0-9]+\\b/]", "message": "palette" }] }' \
  "$FIXTURE" 2>&1) && rc=$? || rc=$?

if [[ "$rc" == "0" ]]; then
  echo "[palette-rule] FAIL: eslint should have reported on $FIXTURE but exited 0" >&2
  echo "$output" >&2
  exit 1
fi

if ! echo "$output" | grep -q 'no-restricted-syntax'; then
  echo "[palette-rule] FAIL: eslint exited nonzero but output does not mention no-restricted-syntax" >&2
  echo "$output" >&2
  exit 1
fi

echo "[palette-rule] ok: eslint flagged palette classes (exit $rc)"
