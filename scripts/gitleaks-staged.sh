#!/usr/bin/env bash
# Opt-in gitleaks hook for staged files. Runs only if `gitleaks` is on
# PATH — contributors who haven't installed it still get CI enforcement
# and aren't blocked from committing.
#
# To install locally:
#   brew install gitleaks               # macOS
#   go install github.com/gitleaks/gitleaks/v8@latest  # from source
#   # or grab a binary from https://github.com/gitleaks/gitleaks/releases

set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  # Silent no-op so contributors without gitleaks installed aren't
  # blocked. CI still enforces on every PR.
  exit 0
fi

# lint-staged passes file paths as arguments. If none, nothing to do.
[[ $# -gt 0 ]] || exit 0

gitleaks protect --staged --config=.gitleaks.toml --redact --no-banner
