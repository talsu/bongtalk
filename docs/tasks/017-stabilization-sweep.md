# Task 017 — Stabilization Sweep: 016 E2E + webhook worktree isolation + main↔develop reconciliation

## Context

Task 016 shipped beta readiness end-to-end and the first real prod
deploy completed (main = `41ee1c4`, webhook → auto-deploy → /readyz
pass, 30 s cycle). The subsequent live verification surfaced five
stabilization gaps that are small but load-bearing before more
feature work lands:

1. Three E2E specs declared in 016 AC (onboarding / feedback /
   beta-invite-required) were deferred as MED follow-ups — GHA
   can't regression-test the three beta operator tools until
   those exist.
2. `auto-deploy.sh` checks out `<sha>` directly in the webhook
   container's bind-mounted repo, which is the same path the
   human operator edits in. Every deploy leaves the host working
   tree in detached HEAD; the operator manually runs
   `git checkout main` to recover. Root cause: webhook and
   operator share the same working tree.
3. `origin/main` is 7 commits ahead of `origin/develop` — all
   prod ops fix-forward. If 017 (or any future task) ships to
   prod before reconciliation, merge conflicts become likely.
4. Two 016 LOW follow-ups (`init-env-deploy.sh` emit of
   `BETA_INVITE_REQUIRED`, `POST /feedback` workspace membership
   check).
5. `/root/.ssh/known_hosts` read-only warning — cosmetic but
   pollutes the audit log.

No new features. Stabilization only. Target size ~1.5–2 days.

## Scope (IN)

### A. 016 closure — 3 E2E specs + 2 LOW follow-ups

#### A-1. E2E specs (GHA)

- `apps/web/e2e/onboarding-checklist.e2e.ts`
  - Fresh signup → card shows 0/4.
  - Create workspace → 1/4; create second channel → 2/4; issue
    an invite → 3/4; send first message → 4/4 → card
    auto-hides.
  - Reload page → dismiss state persists (localStorage).
  - User clicks "X" → card hides; reload → still hidden.
- `apps/web/e2e/feedback-widget.e2e.ts`
  - BottomBar "💬 Feedback" → modal with category select +
    textarea (2000-char counter).
  - Submit (category=bug, content="test 001") → success toast
    "피드백 감사합니다!".
  - Backend round-trip: the test's API client also calls
    `GET /me/feedback?latest=1` (new helper endpoint, admin-only
    is OK since we don't expose to users — or verify via
    submitting user's own row through `listMyFeedback` if simpler).
  - Rate limit: submit 6 times in a row → 6th returns 429,
    error toast.
- `apps/web/e2e/beta-invite-required.e2e.ts`
  - GHA matrix: two jobs, `BETA_INVITE_REQUIRED=true` vs `=false`.
  - `=true` + `/signup` (no invite param) → "This is a closed
    beta" landing with mailto support link. Form disabled.
  - `=true` + `/signup?invite=<code>` → form enabled; submit →
    account created.
  - `=false` + `/signup` → form always available (dev default).

If matrix isn't available, fall back to one job with both
scenarios sequenced via env override (process spawn for the
API server inside the test) — implementer picks.

#### A-2. LOW follow-ups

- **016-follow-4** — `scripts/setup/init-env-deploy.sh` appends
  `BETA_INVITE_REQUIRED=true` to the new `.env.deploy` it
  generates. Does NOT rewrite an existing file. Dry-run mode
  prints the line that would be added.
- **016-follow-5** — `POST /feedback` rejects with
  `404 WORKSPACE_NOT_MEMBER` if the body's `workspaceId` is
  provided but the caller is not a member of that workspace
  (task-019-B (017-follow-1) doc fix: earlier drafts said `403`;
  the actual error-code-to-HTTP mapping is 404. Code unchanged.).
  `workspaceId` omitted (global feedback) still allowed.
  Integration spec: `feedback-workspace-membership.int.spec.ts`.

### B. Webhook git worktree isolation

Current layout:

```
host: /volume2/dockers/qufox   ← operator edits code here
              │
              └── bind-mount RW → container /repo (qufox-webhook)

container's `git checkout --force <sha>` writes through the bind mount,
moves host HEAD into detached state every deploy
```

Target layout:

```
host: /volume2/dockers/qufox        ← operator, main branch
host: /volume2/dockers/qufox-deploy ← webhook-owned worktree of main
              │
              └── bind-mount RW → container /repo

auto-deploy runs `git checkout --force <sha>` inside the worktree;
operator's /volume2/dockers/qufox HEAD is never touched.
```

Choice of `/volume2/dockers/qufox-deploy` over
`/volume3/qufox-data/deploy-repo`: worktree is code-shaped,
ephemeral per deploy, and belongs in the same tier as the other
dockers-hosted service configs (nginx-proxy, qufox itself).
`project_data_layout.md` reserves `/volume3/qufox-data/` for
persistent data (object storage, backups, logs), which a
throwaway checkout is not.

Changes:

- `scripts/setup/migrate-webhook-worktree.sh` — one-shot
  migration script, idempotent. Steps:
  1. Detect `/volume2/dockers/qufox-deploy` state:
     - absent → fresh
     - present as worktree → already migrated, exit 0
     - present as something else → error out, surface for human
  2. `cd /volume2/dockers/qufox && git worktree add /volume2/dockers/qufox-deploy main`
  3. Print the `compose.deploy.yml` diff the operator would
     apply (dry-run mode shows this only, does not write).
  4. Full mode: apply the compose diff + `docker compose -f
compose.deploy.yml up -d --force-recreate qufox-webhook`.
  5. Post-check: `docker exec qufox-webhook sh -c 'cd /repo && git rev-parse --abbrev-ref HEAD'` → `main`.
- `compose.deploy.yml` — `qufox-webhook` service bind-mount
  path changed from `/volume2/dockers/qufox` to
  `/volume2/dockers/qufox-deploy`. Document the requirement that
  `qufox-deploy` must exist as a worktree before
  `docker compose up` is run.
- `scripts/deploy/auto-deploy.sh` — `REPO_PATH` default stays
  the container's `/repo`; no code change needed here since the
  bind-mount abstracts. Audit confirms.
- `docs/ops/runbook-webhook-debug.md` — add "Worktree layout"
  section: why the split exists, what happens if the worktree
  is deleted (recover by re-running migrate script), what
  happens if operator needs to work on main in `/volume2/dockers/qufox`
  while webhook holds `main` in `/qufox-deploy` (git worktree
  allows two worktrees to have the same branch at different
  commits via `git worktree add --detach` + checkout, OR the
  operator moves to a different branch in `/volume2/dockers/qufox`
  and returns when done — document both).
- Post-migration verify: push an empty commit to main, confirm
  deploy succeeds AND host `/volume2/dockers/qufox`'s
  `git branch --show-current` returns `main` (not detached).

### C. main → develop reconciliation

- `git checkout develop && git pull --ff-only`
- `git merge --no-ff main -m "Merge main into develop: 011–016 prod ops fix-forward (safe.directory, docker-cli-compose, -p qufox, --entrypoint prisma, MinIO SERVER_URL, webhook subdomain drop) + worktree prep"`
- Resolve conflicts — expect conflicts in `scripts/deploy/auto-deploy.sh`, `scripts/deploy/rollout.sh`, `scripts/deploy/rollback.sh`, `services/webhook/Dockerfile`, `compose.deploy.yml`. Resolution rule: **accept `main` side** where they overlap with Task 016/017 develop work, because main is the verified-running state. If 017's worktree changes conflict with main's `-p qufox`, merge both (keep `-p qufox` AND new `qufox-deploy` mount).
- After the merge, `git log origin/develop..origin/main --oneline` returns empty.
- When 017 itself merges to develop (direct-merge per memory), the same merge commit carries both 017's feature work and the main→develop reconciliation. Net result after 017 final merge: develop == main + 017.

### D. `/root/.ssh/known_hosts` read-only warning cleanup

- `scripts/deploy/auto-deploy.sh` and other ssh-using scripts:
  add `-o UserKnownHostsFile=/tmp/known_hosts` to all `ssh`
  (and `git fetch`-over-SSH) invocations.
- `services/webhook/Dockerfile` — seed `/tmp/known_hosts` with
  `github.com` key at build time: `RUN ssh-keyscan -H github.com > /tmp/known_hosts-seed && chmod 644 /tmp/known_hosts-seed` (and the runtime copies seed → `/tmp/known_hosts` on container start, so OpenSSH's writes land on the tmpfs copy).
- Post-deploy: `docker logs qufox-webhook` shows no "read-only"
  warning on the next 3 deploys.

## Scope (OUT) — future tasks

- New features (custom emoji, mecab-ko, Loki, etc.) — defer.
- PITR / WAL archiving — separate ops task.
- sops / age secret encryption — separate ops task.
- Residual LOW/NIT from 010/011/012/009/014 — next hygiene sweep.
- Backfill `workspaceId` on historical `Feedback` rows (there
  are none yet; no backfill needed).
- Webhook high-availability / replica — beta out.
- Multi-worktree convention for release branches — beta out;
  current main-only suffices.

## Acceptance Criteria (mechanical)

- `pnpm verify` green.
- `pnpm --filter @qufox/api test:int` green on GitHub Actions,
  new spec:
  - `feedback-workspace-membership.int.spec.ts` (follow-5)
- `pnpm --filter @qufox/web test:e2e` green on GitHub Actions,
  three new specs (`onboarding-checklist`, `feedback-widget`,
  `beta-invite-required`).
- `bash scripts/setup/init-env-deploy.sh --dry-run` output
  contains the `BETA_INVITE_REQUIRED=true` line.
- `bash scripts/setup/migrate-webhook-worktree.sh --dry-run`
  exits 0 and prints the compose diff without writing.
- TODO regression:
  - `grep -rn 'TODO(task-016-follow-1\|TODO(task-016-follow-2\|TODO(task-016-follow-3\|TODO(task-016-follow-4\|TODO(task-016-follow-5\|TODO(task-016-follow-7' --include='*.ts' --include='*.tsx' --include='*.sh' .` returns **0 lines**.
- `git log origin/develop..origin/main --oneline | wc -l` returns
  **0** after the 017 merge completes (develop and main aligned).
- Live prod verification (operator runs once):
  - Execute `scripts/setup/migrate-webhook-worktree.sh` on the
    NAS.
  - Push an empty commit to main.
  - Webhook log shows `exitCode=0`.
  - `cd /volume2/dockers/qufox && git branch --show-current`
    returns `main` (detached HEAD bug is gone).
  - `docker logs qufox-webhook` from the last 3 deploys shows
    no "read-only" warning.
- Three artefacts: `017-*.md`, `017-*.PR.md`, `017-*.review.md`.
- No new eval (no new product feature; the new E2E specs cover
  it).
- Reviewer subagent **actually spawned**; transcript token
  count recorded.
- **Direct merge to develop** (PR creation skipped). Commit:
  `Merge task-017: stabilization sweep — 016 E2E + worktree isolation + main reconciliation`.
- **REPORT printed automatically** after merge.
- Feature branch retained.

## Prerequisite outcomes

- 016 merged to develop (`af72ca8`).
- main at `41ee1c4` (running on prod).
- `docs/ops/runbook-webhook-debug.md`, `runbook-deploy.md`
  exist and can be extended.
- Beta signup path is gated by `BetaInviteRequiredGuard` in
  prod (016-C-2 live).

## Design Decisions

### Merge `main` into `develop`, don't cherry-pick

main is the verified-running state. Cherry-picking the seven
commits recreates them with new SHAs, produces a different
history, and loses the chronological record of the prod
troubleshooting session. A single merge commit preserves it,
and from 017 onward develop==main always after each merge.

### Worktree path stays under `/volume2/dockers/`

`/volume3/qufox-data/` is for persistent data per
`project_data_layout.md`. A webhook-controlled checkout is
ephemeral code, not data. Keeping the worktree next to the
operator's working tree (sibling directory under
`/volume2/dockers/`) also means both are on the same disk —
git's inode-level worktree plumbing (which relies on a `.git`
pointer file) works cross-filesystem but is less surprising
when both roots are local to each other.

### Migration is a script, not runbook steps

Four steps that must happen in order, with correctness-by-check
at each stage. Scripting it removes operator recall load.
Idempotent design means the operator can re-run if confused.

### SSH `UserKnownHostsFile=/tmp/known_hosts`

`/tmp` is tmpfs in the webhook container — writable, lost on
restart, fine for a hosts cache. Seeding the file at build
time means github.com's key is already trusted; OpenSSH's
"add new host" path is moot because the only SSH target is
github.com.

## Non-goals

- Automating main→develop sync going forward (make it a
  per-task decision for now — later tasks may introduce a
  periodic GHA that does it, but 017 just does the first one).
- Moving `/volume2/dockers/qufox` to the `/volume3` disk — the
  disk assignment for code vs data is already the
  `project_data_layout` convention, untouched.
- Rebuilding webhook's Dockerfile to not run as root — larger
  change, defer.

## Risks

- **Merge conflict resolution favors main; 017 develop work may
  silently lose intent.** Explicitly call out in the merge
  commit message which sections took "main side". If Task 016
  design notes say something that main's fix-forward
  contradicted, add an adjudicating comment in code.
- **Migration script on a live prod webhook has a 1–2 min gap
  where GitHub push → webhook miss.** Accepted. GitHub
  redelivery handles it; worst case operator re-pushes an
  empty commit. Document.
- **`git worktree add` creates a new `.git` pointer file in the
  new path; moving/renaming the main repo later breaks this
  link.** Low probability in practice; documented in the
  runbook. If the operator ever needs to relocate the main
  repo, `git worktree repair` restores the link.
- **E2E `beta-invite-required.e2e.ts` with env matrix may
  conflict with existing GHA workflow structure.** Read the
  workflow first; if matrix is already in use for other splits,
  extend; if not, introduce matrix for this one case or run
  two sequential jobs with different env.
- **`GET /me/feedback?latest=1` (helper endpoint for E2E) — is
  it worth introducing?** Alternative: the E2E test reads the
  submitted toast's content, not DB. If toast is enough,
  prefer that; the helper endpoint is risk surface (admin
  disclosure).
- **Operator doesn't have time for the worktree migration
  today.** Acceptable — the worktree code ships in 017 but
  the live migration is a one-shot operator action that the
  runbook describes. Commit-side changes don't affect prod
  until the migration script runs. Document.
- **known_hosts seed at build time pins github.com's key.** If
  GitHub rotates its SSH host keys (rare but documented),
  webhook breaks until the image rebuilds. Accept; rebuild on
  notification.

## Progress Log

_Implementer fills this section. Four commit groups: A
(016 closure), B (worktree code), C (main→develop merge
inside the 017 branch), D (ssh cleanup). Recommended order:
A-1 + A-2 → B → D → C (C last so the merge carries the full
branch; alternative: C first if conflict resolution is
simpler with fewer concurrent changes)._

- [ ] UNDERSTAND (E2E scenario inventory, worktree migration
      path verification, main 7-commit impact analysis, ssh
      call-site audit)
- [ ] PLAN approved
- [ ] SCAFFOLD (E2E skeletons, migrate script stub,
      compose-diff draft)
- [ ] IMPLEMENT (A-1 → A-2 → B → D → C)
- [ ] VERIFY (`pnpm verify` + GHA e2e green + operator
      successfully runs migrate script on prod + empty-commit
      push confirms host HEAD stays on main)
- [ ] OBSERVE (webhook log has no read-only warning post-D,
      auto-deploy log confirms worktree path post-B)
- [ ] REFACTOR
- [ ] REPORT (PR.md, reviewer spawned, direct merge to
      develop, **REPORT printed automatically**)
