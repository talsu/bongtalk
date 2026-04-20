#!/usr/bin/env bash
# Task-017-B: move qufox-webhook from the operator-shared
# /volume2/dockers/qufox bind mount to a dedicated git worktree at
# /volume2/dockers/qufox-deploy.
#
# Problem being solved: auto-deploy.sh runs `git checkout --force
# <sha>` inside the webhook's /repo bind mount. When /repo IS the
# operator's working tree, every deploy puts the operator in
# detached HEAD. A dedicated worktree shares .git objects + refs
# with the main repo but has its own HEAD + working files, so the
# operator can keep editing on `main` while webhook holds a
# different checkout under /qufox-deploy.
#
# Steps:
#   1. Detect /volume2/dockers/qufox-deploy state.
#        absent   → create worktree.
#        present AND is a git worktree → idempotent no-op.
#        present AND is NOT a worktree → bail out for human review.
#   2. In full mode, `docker compose -f compose.deploy.yml up -d
#      --force-recreate qufox-webhook` so the new bind mount takes
#      effect. (compose.deploy.yml commit change is already in the
#      repo; this script just applies it at runtime.)
#   3. Verify: `docker exec qufox-webhook sh -c 'cd /repo && git
#      rev-parse --abbrev-ref HEAD'` returns `main`.
#
# --dry-run walks the steps without mutating anything. Prints the
# exact docker compose command and the expected verify output.
#
# Usage:
#   scripts/setup/migrate-webhook-worktree.sh [--dry-run]

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/volume2/dockers/qufox}"
WORKTREE_PATH="${DEPLOY_WORKTREE:-/volume2/dockers/qufox-deploy}"
WORKTREE_BRANCH="${DEPLOY_WORKTREE_BRANCH:-main}"
CONTAINER="${QUFOX_WEBHOOK_CONTAINER:-qufox-webhook}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '1,32p' "$0" | tail -31; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[migrate-webhook-worktree] %s\n' "$*"; }

# --- step 0: sanity checks -----------------------------------------------
if [[ ! -d "$REPO_ROOT/.git" ]]; then
  echo "[migrate-webhook-worktree] $REPO_ROOT is not a git repo root" >&2
  exit 3
fi
cd "$REPO_ROOT"

# --- step 1: classify the worktree path ----------------------------------
STATE="absent"
if [[ -e "$WORKTREE_PATH" ]]; then
  if git worktree list --porcelain 2>/dev/null | grep -qE "^worktree $WORKTREE_PATH\$"; then
    STATE="worktree"
  else
    STATE="occupied"
  fi
fi

case "$STATE" in
  absent)
    log "target path is absent — will create new worktree at $WORKTREE_PATH (branch $WORKTREE_BRANCH)"
    ;;
  worktree)
    log "target path is already a git worktree — migration is already done"
    # Even so, print the compose command so the operator can re-
    # apply the container if they've changed compose.deploy.yml.
    ;;
  occupied)
    echo "[migrate-webhook-worktree] $WORKTREE_PATH exists but is NOT a git worktree." >&2
    echo "[migrate-webhook-worktree] refusing to touch. Inspect manually:" >&2
    echo "[migrate-webhook-worktree]   ls -la $WORKTREE_PATH" >&2
    echo "[migrate-webhook-worktree]   git -C $REPO_ROOT worktree list" >&2
    echo "[migrate-webhook-worktree] If the directory is leftover junk, rm -rf it and re-run." >&2
    exit 4
    ;;
esac

# --- step 2: plan the actions --------------------------------------------
COMPOSE_CMD=(docker compose --env-file .env.deploy --env-file .env.prod
  -f compose.deploy.yml up -d --force-recreate qufox-webhook)

VERIFY_CMD=(docker exec "$CONTAINER" sh -c 'cd /repo && git rev-parse --abbrev-ref HEAD')

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "--dry-run: would run the following steps:"
  if [[ "$STATE" == "absent" ]]; then
    log "  1. git worktree add $WORKTREE_PATH $WORKTREE_BRANCH"
  else
    log "  1. (skipped — worktree already exists)"
  fi
  log "  2. ${COMPOSE_CMD[*]}"
  log "  3. verify via: ${VERIFY_CMD[*]}"
  log "     expected output: $WORKTREE_BRANCH"
  exit 0
fi

# --- step 3: execute -----------------------------------------------------
if [[ "$STATE" == "absent" ]]; then
  log "creating worktree: git worktree add $WORKTREE_PATH $WORKTREE_BRANCH"
  if ! git worktree add "$WORKTREE_PATH" "$WORKTREE_BRANCH"; then
    echo "[migrate-webhook-worktree] git worktree add failed — aborting" >&2
    exit 5
  fi
fi

log "recreating $CONTAINER so the new bind mount takes effect"
if ! "${COMPOSE_CMD[@]}"; then
  echo "[migrate-webhook-worktree] docker compose recreate failed — inspect manually" >&2
  exit 6
fi

# Wait a couple seconds for the container to boot before verifying.
sleep 3

log "verifying container sees /repo = worktree on $WORKTREE_BRANCH"
ACTUAL_BRANCH="$("${VERIFY_CMD[@]}" 2>/dev/null || echo FAILED)"
if [[ "$ACTUAL_BRANCH" != "$WORKTREE_BRANCH" ]]; then
  echo "[migrate-webhook-worktree] verify FAILED — container sees branch=$ACTUAL_BRANCH (expected $WORKTREE_BRANCH)" >&2
  exit 7
fi
log "ok — $CONTAINER's /repo is on branch $ACTUAL_BRANCH (worktree at $WORKTREE_PATH)"

# --- step 4: operator-facing reminder ------------------------------------
cat <<EOF

Migration done. From now on:
  - /volume2/dockers/qufox          ← YOU (operator) edit here; HEAD stays on your branch.
  - $WORKTREE_PATH ← webhook owns this; auto-deploy.sh moves its HEAD.

Next push to main triggers a deploy that operates on the worktree
instead of your editing tree. Verify once:

  # on the NAS:
  git -C /volume2/dockers/qufox branch --show-current        # → main (or your dev branch)
  git -C $WORKTREE_PATH branch --show-current   # → $WORKTREE_BRANCH (or detached at a sha after a deploy)

EOF
