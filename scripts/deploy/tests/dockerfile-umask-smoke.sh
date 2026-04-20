#!/usr/bin/env bash
# Task-020-B: regression guard against a NAS-umask-0077 rebuild shipping
# 0600 files in production images.
#
# Background: on 2026-04-20 a manual `rollout.sh web` invoked directly
# from the NAS shell (umask 0077) produced a web image whose
# /design-system/* and /brand-assets/* files were 0600 root:root. nginx
# worker runs as `nginx` and returned 403 for every static asset.
# Hotfix chmodded during Dockerfile runtime. This script ensures a
# future edit doesn't silently regress.
#
# Strategy:
#   1. umask 0077 at script entry so files touched before COPY inherit
#      the hostile mode.
#   2. Build both images with --no-cache so layers are re-computed
#      under this umask (cached layers from a previous 0022 build would
#      hide the regression).
#   3. Spin a disposable container, `ls -la` the payload directory,
#      require every regular file to be world-readable. Exit non-zero
#      on any 0600 (or worse).
#
# Usage (from repo root):
#   bash scripts/deploy/tests/dockerfile-umask-smoke.sh
#   pnpm docker:build:smoke                      # same, via package.json
#
# Safe to re-run; each probe container is --rm. Does not touch the
# :latest / :prev tags — images are built with the explicit name
# qufox-umask-smoke:<svc>.
#
# GHA: wired into .github/workflows/integration.yml as a dedicated
# job so the PR check list surfaces it. On ubuntu-latest the runner's
# shell umask is 022 by default; this script forces 077.

set -euo pipefail

umask 0077

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
cd "$REPO_ROOT"

log() { printf '[umask-smoke] %s\n' "$*"; }
fail() { printf '[umask-smoke] FAIL: %s\n' "$*" >&2; exit 1; }

# --- Build both images with --no-cache under umask 0077 -------------
log "building qufox-umask-smoke:api (no cache, umask 0077)"
if ! docker build --no-cache -t qufox-umask-smoke:api -f apps/api/Dockerfile . >/dev/null; then
  fail "api image build failed"
fi
log "building qufox-umask-smoke:web (no cache, umask 0077)"
if ! docker build --no-cache -t qufox-umask-smoke:web -f apps/web/Dockerfile . >/dev/null; then
  fail "web image build failed"
fi

# --- Inspect permissions inside each image ---------------------------
# Runs `find` + `stat` to dump octal perms. We reject any regular file
# whose octal mode doesn't have the world-read bit (last digit & 4).
#
# The check uses `find ... -type f -printf '%m %p\n'` which is a GNU
# extension. alpine ships busybox find, which DOES implement -printf
# on recent releases; fallback uses `stat -c`. We try the portable
# stat form first.

probe_image() {
  local tag="$1"
  local path="$2"
  log "probing $tag — $path must be world-readable"
  # shellcheck disable=SC2016
  local bad
  bad="$(
    docker run --rm --entrypoint sh "$tag" -c '
      set -e
      p="'"$path"'"
      if [ ! -e "$p" ]; then
        echo "PROBE_MISSING $p"
        exit 0
      fi
      find "$p" -type f -print0 | while IFS= read -r -d "" f; do
        m=$(stat -c "%a" "$f")
        # octal third digit is "other"; must have the 4 bit
        other=$(( m % 10 ))
        if [ $(( other & 4 )) -eq 0 ]; then
          echo "BAD_PERM $m $f"
        fi
      done
    '
  )" || true
  if echo "$bad" | grep -q PROBE_MISSING; then
    fail "$tag: probe path missing — $bad"
  fi
  if echo "$bad" | grep -q BAD_PERM; then
    echo "$bad" >&2
    fail "$tag: some files are NOT world-readable (see BAD_PERM lines above)"
  fi
  log "$tag — all files in $path are world-readable"
}

probe_image qufox-umask-smoke:api /app/dist
probe_image qufox-umask-smoke:web /usr/share/nginx/html

log "ok — both images pass the umask 0077 smoke"
