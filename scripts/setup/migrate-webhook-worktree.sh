#!/usr/bin/env bash
# Task-017-B: give qufox-webhook a dedicated sibling clone at
# /volume2/dockers/qufox-deploy so `git checkout --force <sha>`
# during auto-deploy stops touching the operator's working tree.
#
# Original design called this a "git worktree"; the filename still
# reflects that intent. Implementation switched to a `git clone`
# + `remote set-url` pattern during the live prod run because a
# worktree's `.git` file stores an absolute pointer to the main
# repo's `.git/worktrees/<name>` directory — that path is not
# reachable from inside the webhook container (the bind mount is
# `/repo`, not `/volume2/dockers/qufox`). A full clone is
# self-contained: the webhook container's `/repo` is a real
# standalone `.git`, so `git fetch origin main` works the same way
# it did when the container bind-mounted the operator tree.
#
# Trade-off: the deploy clone is ~8-10 MB vs sharing objects with
# the main repo. Negligible on /volume2 (hundreds of GB free),
# and the clean container-accessible layout is worth it.
#
# Steps:
#   1. Detect /volume2/dockers/qufox-deploy state.
#        absent               → create sibling clone.
#        present AND is a git repo → idempotent no-op.
#        present AND is NOT a git repo → bail for human review.
#   2. `docker compose -f compose.deploy.yml up -d
#      --force-recreate qufox-webhook` so the new bind mount
#      takes effect.
#   3. Verify: container sees /repo as a real git repo whose HEAD
#      SHA matches origin/main on the operator tree.
#
# --dry-run walks the steps without mutating anything. Prints the
# exact docker compose command and expected verify output.
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
  if [[ -d "$WORKTREE_PATH/.git" ]] || [[ -f "$WORKTREE_PATH/.git" ]]; then
    STATE="repo"
  else
    STATE="occupied"
  fi
fi

case "$STATE" in
  absent)
    log "target path is absent — will create sibling clone at $WORKTREE_PATH (branch $WORKTREE_BRANCH)"
    ;;
  repo)
    log "target path is already a git repo — migration is already done"
    # Even so, print the compose command so the operator can re-
    # apply the container if they've changed compose.deploy.yml.
    ;;
  occupied)
    echo "[migrate-webhook-worktree] $WORKTREE_PATH exists but is NOT a git repo." >&2
    echo "[migrate-webhook-worktree] refusing to touch. Inspect manually:" >&2
    echo "[migrate-webhook-worktree]   ls -la $WORKTREE_PATH" >&2
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
  # Resolve the origin URL from the main repo so the clone tracks
  # the same GitHub remote the operator works against.
  ORIGIN_URL="$(git -C "$REPO_ROOT" remote get-url origin)"
  if [[ -z "$ORIGIN_URL" ]]; then
    echo "[migrate-webhook-worktree] could not read origin URL from $REPO_ROOT" >&2
    exit 5
  fi
  log "cloning local repo → $WORKTREE_PATH"
  if ! git clone --branch "$WORKTREE_BRANCH" "$REPO_ROOT" "$WORKTREE_PATH"; then
    echo "[migrate-webhook-worktree] git clone failed — aborting" >&2
    exit 5
  fi
  # Reset origin to the GitHub URL so auto-deploy.sh's
  # `git fetch origin $BRANCH` pulls from the real upstream, not
  # the sibling local repo on disk (which would only have the
  # operator's latest `git fetch`).
  log "pointing clone's origin at $ORIGIN_URL"
  git -C "$WORKTREE_PATH" remote set-url origin "$ORIGIN_URL"
  # Verify + prime by running a dry fetch. This also populates the
  # ssh known_hosts entry the first time if needed.
  if ! git -C "$WORKTREE_PATH" fetch --dry-run origin "$WORKTREE_BRANCH" 2>/dev/null; then
    log "(note) initial ssh fetch against $ORIGIN_URL failed; webhook will retry on first deploy."
  fi
  # `.env.prod` + `.env.deploy` are `.gitignore`d, so `git clone`
  # didn't bring them. Symlink to the operator tree's copies so
  # they stay single-sourced (operator rotates a secret → webhook
  # sees it on the next deploy without another script run).
  log "symlinking .env.prod + .env.deploy from $REPO_ROOT"
  ln -sf "$REPO_ROOT/.env.prod"   "$WORKTREE_PATH/.env.prod"
  ln -sf "$REPO_ROOT/.env.deploy" "$WORKTREE_PATH/.env.deploy"
fi

log "recreating $CONTAINER so the new bind mount takes effect"
if ! "${COMPOSE_CMD[@]}"; then
  echo "[migrate-webhook-worktree] docker compose recreate failed — inspect manually" >&2
  exit 6
fi

# Wait a couple seconds for the container to boot before verifying.
sleep 3

# `--abbrev-ref HEAD` returns `HEAD` for a detached worktree (which
# is how we created it) and `main` if the worktree happens to be on
# a branch. Either is fine — both prove the bind mount points at
# a real git checkout. We also confirm the commit SHA matches main's
# current tip so the operator can be confident the seed is fresh.
# Task-016 ops fix-forward was to `git config --global --add
# safe.directory /repo` inside `auto-deploy.sh` at deploy time; the
# verify step here runs before the first deploy, so apply the same
# config ourselves so `git rev-parse` can see the repo. (Running
# as root inside the container, bind-mount dir owner is admin:users
# on the host — git bails with "dubious ownership" without the
# exception.)
docker exec "$CONTAINER" git config --global --add safe.directory /repo >/dev/null 2>&1 || true

log "verifying container sees /repo as a git checkout"
ACTUAL_REF="$(docker exec "$CONTAINER" sh -c 'cd /repo && git rev-parse --abbrev-ref HEAD' 2>/dev/null || echo FAILED)"
ACTUAL_SHA="$(docker exec "$CONTAINER" sh -c 'cd /repo && git rev-parse HEAD' 2>/dev/null || echo FAILED)"
EXPECTED_SHA="$(git rev-parse "$WORKTREE_BRANCH")"
if [[ "$ACTUAL_REF" != "$WORKTREE_BRANCH" && "$ACTUAL_REF" != "HEAD" ]]; then
  echo "[migrate-webhook-worktree] verify FAILED — unexpected ref: $ACTUAL_REF" >&2
  exit 7
fi
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  echo "[migrate-webhook-worktree] verify FAILED — SHA mismatch: container=$ACTUAL_SHA host=$EXPECTED_SHA" >&2
  exit 7
fi
log "ok — $CONTAINER's /repo is checked out at $WORKTREE_BRANCH ($ACTUAL_SHA, ref=$ACTUAL_REF)"

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
