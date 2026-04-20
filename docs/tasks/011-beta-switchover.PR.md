# Task 011 — Beta Switchover: change log

_No GitHub PR was opened for this task. Per the user's instruction, the
operating mode changed from "PR + human review" to "reviewer subagent +
direct merge to develop." This file is the change log kept alongside
the other task artefacts; it is NOT pasted into GitHub._

**Branch**: `feat/task-011-beta-switchover`
**Target**: `develop`
**Merge command**: `git merge --no-ff feat/task-011-beta-switchover -m "Merge task-011: beta switchover + mention notify + 009 MED + CI tests"`

## Summary

Four independent chunks took the 009 deploy stack from "built but
never used" to "live beta," shipped mention notifications
(backend → WS → toast → sidebar badge → jump), closed the four
MED-severity items the 009 reviewer flagged, and finally got
`test:int` / `test:e2e` running on GitHub Actions instead of
being deferred-with-excuses.

### A. Switchover automation

- `scripts/setup/init-env-deploy.sh` — generates `.env.deploy`,
  refuses to overwrite, `--dry-run` mode. Reads `POSTGRES_PASSWORD`
  from `.env.prod` (not duplicated).
- `scripts/setup/apply-nginx-diff.sh` — idempotent `deploy.qufox.com`
  block install with `.bak.<epoch>` snapshot and `nginx -t`
  auto-rollback.
- `scripts/setup/post-switchover-smoke.sh` — 4 checks
  (webhook `/healthz`, 6 containers Up, api `/readyz`, webhook
  redelivery command).
- `docs/ops/switchover-checklist.md` — 14-step operator table with
  validation + rollback columns.
- `scripts/deploy/test-syntax.sh` extended to cover `scripts/setup/*.sh`.

### B. Mention notifications

- Backend: `MessageService.send` emits one `mention.received` outbox
  event per unique mentioned user inside the same transaction as
  `message.created`. Self-mentions skipped, duplicates deduped via
  a Set. Snippet (whitespace-collapsed ≤140 chars) travels on the
  envelope so the toast is self-contained.
- `OutboxAggregate` union gains `'UserMention'`. `@OnEvent('mention.**')`
  in `outbox-to-ws.subscriber.ts` routes to `rooms.user(targetUserId)`
  with replay-buffer scope 'user'.
- `GET /me/mentions` via jsonb containment (GIN partial index,
  `CREATE INDEX CONCURRENTLY … WHERE "deletedAt" IS NULL`).
  `unreadCount` drives off `UserChannelReadState.lastReadAt` so
  opening a channel clears its mentions — no separate read table.
- Frontend: dispatcher branch bumps cache + shows `variant='mention'`
  toast + click-to-jump navigates via `pushState + popstate`.
  Token-bucket throttle caps at 5 toasts/sec; overflow collapses
  into `"N more mentions"` on a 1s timer.
- Sidebar `@ mentions` badge above ChannelList when unreadCount > 0.
- E2E: `apps/web/e2e/realtime/mention-notification.e2e.ts` covers
  toast → badge → jump → unread-pill clears (cross-feature w/
  task-010-B).

### C. 009 MED cleanup

- **MED-1**: `AuditLog` gains size-based rotation (default 5 MB / 5
  files). Rotation serialised via a promise chain; errors fall
  through to stderr. New `audit-rotation.spec.ts` (4 cases).
- **MED-2**: `scripts/prod-reload.sh` sources `scripts/deploy/lock.sh`
  and calls `deploy::acquire_lock` / `trap release`. Runbook line
  rewritten (was a lie). New `scripts/deploy/test-lock-shared.sh`
  proves the shared-flock semantics (blocks via flock -n 9).
- **MED-3**: `scripts/backup/restore-test.sh` threshold is
  env-configurable (`MIN_RESTORE_USER_COUNT`, default 1). Empty-DB
  snapshots no longer false-positive.
- **MED-4**: `scripts/backup/redis-backup.sh` reads `LASTSAVE` BEFORE
  `BGSAVE`, asserts the command actually started, then polls for
  strict advancement. Exits 2 on BGSAVE-error, 3 on 60s no-advance
  timeout.

### D. CI test pipeline

- `.github/workflows/integration.yml` rewritten: drops the redundant
  service containers (testcontainers handles it), adds turbo cache,
  matches NAS `TESTCONTAINERS_RYUK_DISABLED=true` pattern.
- `docker-compose.test.yml` (new): 4 services (`test-postgres`,
  `test-redis`, `test-api`, `test-web`) with healthchecks; api
  exposes :43001, web :45173 matching the e2e URL convention.
- `.github/workflows/e2e.yml` rewritten: uses `docker compose up -d
--build`, waits 60s for `/readyz`, runs Playwright, uploads traces
  on failure, tears down in an always-run shutdown step.
- Removed `deploy-prod.yml`, `deploy-staging.yml`, `db-migrate.yml`
  — all were TODO(task-010) placeholders for a K8s canary path that
  isn't the shipped design. The 009/010 webhook → NAS pipeline is
  the MVP deploy route; the K8s path reappears when qufox moves
  off the NAS, as a new task.

## Test plan

- [x] `pnpm verify` green after every chunk (19/19 turbo tasks).
- [x] `pnpm --filter @qufox/webhook test` — 49/49 (45 prior + 4
      audit-rotation).
- [x] `pnpm --filter @qufox/api test` — 50/50 unit.
- [x] `pnpm --filter @qufox/web test` — 4/4.
- [x] `bash scripts/deploy/test-syntax.sh` — covers deploy + backup +
      setup scripts.
- [x] `bash scripts/deploy/test-lock-shared.sh` — proves prod-reload
      shares the flock.
- [x] `bash scripts/setup/init-env-deploy.sh --dry-run` — exits 0
      without writing `.env.deploy`.
- [x] Grep `TODO(task-009-med-` outside review doc → **0 lines**.
- [x] All three artefacts (this file, `011-beta-switchover.md`,
      `011-beta-switchover.review.md`) on disk.
- [x] Evals `024-mention-delivery.yaml` and
      `025-switchover-dryrun.yaml` present.
- [x] Reviewer subagent spawned; transcript stats in review header.
- [ ] `pnpm --filter @qufox/api test:int` — runs on GitHub Actions
      on every push; local NAS still lacks testcontainers.
- [ ] `pnpm --filter @qufox/web test:e2e` — runs on GHA via compose;
      first green run is the switchover-day dependency.

## Commit sequence

```
8caf277 docs(task-011):      beta-switchover task contract
5b45136 feat(switchover):    task-011-A — switchover automation + checklist
90c0021 fix(deploy):         task-011-C — resolve 009 reviewer MED items (4)
e5d966c feat(ci):            task-011-D — integration + e2e GHA + compose test stack
06e8937 feat(mentions):      task-011-B — mention notifications end-to-end
```

(plus evals + PR.md + reviewer-response commits before direct merge.)

## Direct merge plan

```sh
git checkout develop
git pull --ff-only
git merge --no-ff feat/task-011-beta-switchover \
  -m "Merge task-011: beta switchover + mention notify + 009 MED + CI tests"
git push origin develop
```

Then ask the user whether to delete the local + remote feature branch.
If the reviewer subagent raised any BLOCKER or HIGH, fix forward on
the same branch and re-spawn the reviewer before running the merge.
