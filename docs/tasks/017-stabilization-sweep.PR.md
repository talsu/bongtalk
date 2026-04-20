# Task 017 PR — Stabilization Sweep: 016 E2E + webhook worktree isolation + main↔develop reconciliation

**Branch:** `feat/task-017-stabilization-sweep`
**Base:** `develop` (`af72ca8`)
**Merge style:** direct `git merge --no-ff` to develop
**Memory:** `feedback_skip_pr_direct_merge.md`, `feedback_retain_feature_branches.md`, `feedback_handoff_must_include_report.md`

## Summary

- **A — 016 closure (3 E2E + 2 LOW)**
  - `apps/web/e2e/shell/onboarding-checklist.e2e.ts` — 0→4 progression + auto-dismiss on complete + manual ✕ dismiss + localStorage persistence on reload
  - `apps/web/e2e/shell/feedback-widget.e2e.ts` — BottomBar 💬 → modal → submit → "피드백 감사합니다!" toast + 5 API submits succeed + 6th returns 429 RATE_LIMITED
  - `apps/web/e2e/auth/beta-invite-required.e2e.ts` — gated mode spec (skip unless `BETA_INVITE_REQUIRED=true` in GHA matrix); missing `inviteCode` → 403, valid seeded `inviteCode` → 201, invite `usedCount` unchanged
  - `scripts/setup/init-env-deploy.sh` now emits `BETA_INVITE_REQUIRED=true` in the `.env.deploy` skeleton (016-follow-4)
  - `POST /feedback` validates body `workspaceId` against caller's WorkspaceMember row → non-member gets `WORKSPACE_NOT_MEMBER` (404). `workspaceId=null` still allowed (global feedback). New int spec `feedback-workspace-membership.int.spec.ts` covers all three branches (016-follow-5)
- **B — Webhook git worktree isolation**
  - `scripts/setup/migrate-webhook-worktree.sh` — idempotent migration script: classifies path (absent/worktree/occupied), runs `git worktree add /volume2/dockers/qufox-deploy main`, recreates qufox-webhook via `docker compose up -d --force-recreate`, verifies via `docker exec ... rev-parse --abbrev-ref HEAD`. `--dry-run` prints the plan without mutating.
  - `compose.deploy.yml` — qufox-webhook volume entry changed to `${DEPLOY_WORKTREE:-/volume2/dockers/qufox-deploy}:/repo`.
  - `docs/ops/runbook-webhook-debug.md` — new "Worktree layout" section: why the split, migration one-liner, verify commands, recovery (re-run script), dual-tree-on-same-branch workflow, `git worktree repair` for main-repo relocation.
  - **Operator action required** — code ships; live migration is a one-shot NAS-side script call (see REPORT).
- **C — main → develop reconciliation**
  - `git merge --no-ff origin/main` brought 7 ops commits from main into this branch (clean merge, no conflicts). Develop + 017 merge will equalize: `git log origin/develop..origin/main | wc -l` → 0.
- **D — SSH known_hosts read-only warning**
  - `services/webhook/Dockerfile`: build-time `ssh-keyscan` seeds `/tmp/known_hosts-seed`; container CMD copies to `/tmp/known_hosts` (tmpfs). Runtime image gains `openssh-client` already (inherited from main merge).
  - `scripts/deploy/auto-deploy.sh`: `export GIT_SSH_COMMAND='ssh -o UserKnownHostsFile=/tmp/known_hosts ...'` routes git's ssh through tmpfs instead of `/root/.ssh/known_hosts` (ro).
- **Side commits** — `.gitignore` now ignores `.env.prod.bak.*`, `*.zip`, `*.tar.gz`; two accidental `git add -A` captures (env backup + design zip) were amended out of their respective commits.

## Verify

```
pnpm verify → 19/19 success, 0 errors
```

- `@qufox/api:typecheck` ✓
- `@qufox/api:test` ✓
- `@qufox/webhook:test` ✓ (50 tests, no regression from Dockerfile changes)
- `@qufox/shared-types:test` ✓
- `@qufox/web:test` ✓ (17 tests)
- `@qufox/web:typecheck` ✓

**Migrate script smoke (dry-run):**

```
$ bash scripts/setup/migrate-webhook-worktree.sh --dry-run
[migrate-webhook-worktree] target path is absent — will create new worktree at /volume2/dockers/qufox-deploy (branch main)
[migrate-webhook-worktree] --dry-run: would run the following steps:
[migrate-webhook-worktree]   1. git worktree add /volume2/dockers/qufox-deploy main
[migrate-webhook-worktree]   2. docker compose --env-file .env.deploy --env-file .env.prod -f compose.deploy.yml up -d --force-recreate qufox-webhook
[migrate-webhook-worktree]   3. verify via: docker exec qufox-webhook sh -c cd /repo && git rev-parse --abbrev-ref HEAD
[migrate-webhook-worktree]      expected output: main
```

## New int + e2e specs (GHA)

- `apps/api/test/int/feedback/feedback-workspace-membership.int.spec.ts` — 3 cases
- `apps/web/e2e/shell/onboarding-checklist.e2e.ts` — 2 tests
- `apps/web/e2e/shell/feedback-widget.e2e.ts` — 1 test
- `apps/web/e2e/auth/beta-invite-required.e2e.ts` — 2 tests (gated on GHA matrix)

## Commits

```
51e16e3 fix(webhook): task-017-D — silence known_hosts read-only warning
acef30c feat(webhook): task-017-B — git worktree isolation for qufox-webhook
fa6b7ca Merge origin/main into feat/task-017 — 011-016 prod ops fix-forward + worktree prep
74326a7 feat(016-closure): task-017-A — 3 E2E + 2 LOW follow-ups
c667507 docs(task-017): stabilization sweep task contract
```

The `fa6b7ca` merge consolidates main's 7 ops commits (safe.directory, docker-cli-compose, -p qufox, --entrypoint prisma, MinIO SERVER_URL, webhook-subdomain drop, + two empty trigger commits) plus the 011-016 prod deploy merge. No conflicts arose.

## Post-merge verification (after `develop` merge)

```
git log origin/develop..origin/main --oneline | wc -l   # → 0
```

## Operator manual steps (not automated — documented here and in REPORT)

1. Pull develop's latest on the NAS
2. Run `bash scripts/setup/migrate-webhook-worktree.sh --dry-run` to preview, then without `--dry-run` to apply
3. Rebuild the webhook image once for the task-017-D Dockerfile changes (`docker compose -f compose.deploy.yml build qufox-webhook && docker compose -f compose.deploy.yml up -d --force-recreate qufox-webhook`)
4. Push an empty commit to main as a smoke → confirm `docker logs qufox-webhook` shows no "Read-only file system" and `git -C /volume2/dockers/qufox branch --show-current` returns `main` (detached-HEAD bug gone)
