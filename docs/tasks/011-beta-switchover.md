# Task 011 — Beta Switchover + Mention Notify + 009 MED Cleanup + CI Test Pipeline

## Context

Task 009/010 laid the deploy infrastructure and made the MVP feel right
in the chair (unread dots, focus rings, deploy metrics). But the **beta
hasn't actually launched**: `.env.deploy` was never written, the
`deploy.qufox.com` nginx server block was never installed, and the
webhook has never received a real GitHub push. The first automatic
deploy is still the next manual step.

Meanwhile mentions are parsed in 004 and stored in the message row but
nobody is told. The 009 reviewer flagged four MED-severity operational
risks that didn't get fixed in 010 (audit log unbounded, runbook lies
about flock sharing, restore-test passes on empty DB, redis BGSAVE
race). And `test:int` / `test:e2e` have been "not run" on this NAS for
two tasks running because there's no testcontainers / full stack here —
which means everything since 008 has shipped without a regression net.

Task 011 takes the beta live in one pass: switchover automation, mention
notifications (reusing 007 dispatcher + 010 toast queue), the four MED
cleanups, and a GitHub Actions pipeline that finally runs `test:int`
and `test:e2e` on every change.

No new database tables. Read-state and mention rows already exist.

## Scope (IN)

### A. Switchover automation

- `scripts/setup/init-env-deploy.sh` — wizard that:
  - Refuses to overwrite an existing `.env.deploy`.
  - Generates `GITHUB_WEBHOOK_SECRET` via `openssl rand -hex 32`.
  - Reads `POSTGRES_PASSWORD` from `.env.prod` (does not duplicate
    storage; if absent, errors with the exact missing-key message).
  - Prints the webhook secret once at the end with a clear
    "paste this into GitHub → Settings → Webhooks" instruction.
  - Supports `--dry-run` that prints what would happen without
    writing.
- `scripts/setup/apply-nginx-diff.sh`:
  - Snapshots `/volume2/dockers/nginx/nginx.conf` to `.bak.<epoch>`.
  - Idempotently inserts the `deploy.qufox.com` server block from
    `docs/ops/runbook-nginx-diff.md` (detects existing block by host
    match; no-op if already present).
  - Runs `docker exec nginx-proxy-1 nginx -t`.
  - On failure: restores the `.bak`, exits non-zero, leaves nginx
    unchanged.
  - On success: `docker exec nginx-proxy-1 nginx -s reload`.
- `scripts/setup/post-switchover-smoke.sh`:
  - Curls `https://deploy.qufox.com/healthz` (the webhook's own
    health endpoint).
  - `docker ps` checks `qufox-webhook` and `qufox-backup` are `Up`.
  - Reads the most recent webhook delivery from GitHub via
    `payload.after` round-trip — relies on the operator pasting a
    redelivery curl, prints the canonical command.
  - Confirms `/readyz` on `qufox-api` is 200 (not just 200ish — the
    full deep-readiness from 007).
- `docs/ops/switchover-checklist.md`:
  - Two-column table: **operator action** vs **automation runs**, in
    strict order.
  - Per step: validation command + expected exit code, rollback
    command if it fails.
  - Pre-flight section verifies all four scripts present, executable,
    `bash -n` clean.

### B. Mention notifications (closes the user-facing half of TODO(task-021))

- Backend:
  - When `MessageService.create` parses mentions, emit a per-user
    outbox event `mention.received` with `{ messageId, channelId,
workspaceId, mentionedUserId, snippet }`. Reuses the
    transactional outbox from task-003 — same DNA, no new write
    path.
  - WS gateway dispatches the event to `user:<id>` rooms (already
    exists from 005 presence, no new subscription model).
- Frontend:
  - New dispatcher branch in `features/realtime/dispatcher.ts` for
    `mention.received`. Pushes to the 010 toast queue with
    `variant: "mention"` and a "Jump" action that navigates to
    `/w/:wsSlug/c/:channelSlug?msg=<messageId>`.
  - `useMentionInbox()` query: returns `{ unreadCount, recent[] }`.
    Backend route `GET /me/mentions?cursor=...` reads jsonb
    containment from `messages.mentions @> [{userId: :me}]` indexed
    by GIN.
  - Browser Notification API: opt-in permission flow on first
    sign-in (deferred 24h after page load to avoid bait), shown only
    if permission state is `default`. HTTPS-only.
  - Sidebar badge above ChannelList showing total unread mentions.
- Throttle: dispatcher caps at 5 toasts / second per user; excess
  drops to "+N more mentions" collapsed toast. Audit logged via
  metric `qufox_mention_toast_dropped_total`.
- Playwright E2E `apps/web/e2e/mention-notification.e2e.ts`:
  - 2 contexts. A posts `@B-real-userId` style mention. B sees toast
    - sidebar badge +1 within 2s. B clicks toast Jump → URL
      contains `?msg=<id>`. Mention dot in ChannelList from 010
      confirms cross-feature integrity.

### C. 009 MED cleanup (4 items)

- **MED-1** — `services/webhook` `audit.jsonl` rotation. Size-based
  (5 MB → `audit.jsonl.1`, max 5 files retained). Done in-process so
  no external `logrotate` dep.
- **MED-2** — `scripts/prod-reload.sh` sources `scripts/deploy/lock.sh`
  so the manual path holds the same flock fd 9. Update
  `docs/ops/runbook-deploy.md` to stop claiming this has been true
  (and remove the apology). Add a script-level test:
  `scripts/deploy/test-syntax.sh` already runs `bash -n`; add a
  `test/lock-shared.sh` that asserts the two scripts both block on
  the same path.
- **MED-3** — `scripts/backup/restore-test.sh` checks
  `SELECT count(*) FROM "User" >= ${MIN_RESTORE_USER_COUNT:-1}`,
  not just `>= 1`. The threshold env var lets operators bump it as
  the user base grows, so an empty restored DB never passes.
- **MED-4** — `scripts/backup/redis-backup.sh` reads `LASTSAVE`
  before issuing `BGSAVE`, then polls until it changes (or 60s
  timeout). Removes the silent race where the dump is copied
  before BGSAVE finishes. Logs warning + exits 1 on timeout.

### D. CI test pipeline

- `.github/workflows/integration.yml`:
  - `services: postgres:16, redis:7` with healthchecks.
  - Steps: checkout, pnpm install, prisma migrate deploy against
    the service postgres, `pnpm test:int`.
  - Triggers: PR + push to `develop` + push to `main`.
  - Caches pnpm + turbo to keep run < 5min.
- `.github/workflows/e2e.yml`:
  - Uses `docker compose -f docker-compose.test.yml up -d`
    (new compose file: postgres + redis + api + web, all from
    pre-built images or local build).
  - Waits for `/readyz` (60s timeout).
  - Runs `pnpm --filter @qufox/web test:e2e`.
  - Uploads Playwright traces (retain-on-failure) + screenshots
    (only-on-failure) as workflow artifacts.
- Both workflows are required checks for merging to develop (set in
  branch protection — operator opt-in, since direct-merge bypasses
  PR but CI still runs on push).
- Drop the existing `.github/workflows/integration.yml` and
  `.github/workflows/e2e.yml` placeholders that print
  `TODO(task-010)` — they're empty shells today.

## Scope (OUT) — future tasks

- Attachments (S3 / MinIO presign URLs) — TODO(task-017).
- Reactions — TODO(task-023).
- Threads — TODO(task-024).
- Full-text search — TODO(task-025).
- PITR / WAL archiving — separate ops task.
- Secret management upgrade (sops / Vault) — separate ops task.
- Loki log aggregation — TODO(task-019).
- Tail-based sampling policy — TODO(task-020).
- 009 LOW/NIT items (7 left) and task-010-follow-1..6 — bundle into
  a smaller hygiene task later.

## Acceptance Criteria (mechanical)

- `pnpm verify` green. Log attached to `docs/tasks/011-*.PR.md`.
- `pnpm --filter @qufox/api test:int` green **on GitHub Actions**.
  NAS-not-run is no longer accepted as a deferral.
- `pnpm --filter @qufox/web test:e2e` green **on GitHub Actions**
  with `mention-notification.e2e.ts` newly added.
- `pnpm --filter @qufox/webhook test` green, including
  `audit-rotation.spec.ts`.
- `bash scripts/setup/init-env-deploy.sh --dry-run` exits 0 and
  prints the would-write content; **does not** write `.env.deploy`.
- `bash scripts/deploy/test-syntax.sh` green (now covers the three
  new `scripts/setup/*.sh`).
- `grep -rn 'TODO(task-009-med-' . | grep -v '\.review\.md'` returns
  **0 lines** (the four MEDs all resolved in code; only the
  historical reference in the review doc may remain).
- `docs/ops/switchover-checklist.md` exists and lists all four
  switchover scripts as referenced steps.
- Three artefacts present:
  - `docs/tasks/011-beta-switchover.md` (this file)
  - `docs/tasks/011-beta-switchover.PR.md`
  - `docs/tasks/011-beta-switchover.review.md`
- Two new evals:
  - `evals/tasks/024-mention-delivery.yaml`
  - `evals/tasks/025-switchover-dryrun.yaml`
- Reviewer subagent **actually spawned**; transcript token count
  recorded in `011-*.review.md` header.
- Both new GitHub Actions workflows have at least one successful
  run on the feature branch before merge.

### Operating mode change — direct merge

This task ends with **direct merge to develop**, not a GitHub PR.
After all `Acceptance Criteria` pass and any reviewer-raised BLOCKER
or HIGH is fixed forward:

```sh
git checkout develop
git pull --ff-only
git merge --no-ff feat/task-011-beta-switchover \
  -m "Merge task-011: beta switchover + mention notify + 009 MED + CI tests"
git push origin develop
```

Then prompt the user once whether to delete the local + remote feature
branch. The `docs/tasks/011-beta-switchover.PR.md` is still produced
(as a change log) but no `gh pr create` call.

## Prerequisite outcomes

- 009 + 010 merged to develop (`origin/develop` at `954bcd3` confirms).
- 009 reviewer's BLOCKER 1/2 + HIGH 3/4/5 already resolved in 010
  commit 241cfec — no overlap with this task's MED cleanup.
- Branch `feat/task-011-beta-switchover` cut from `origin/develop`.

## Design Decisions

### Mention dispatcher reuses outbox, not a separate table

The mention is already a fact about a message. Adding a
`MentionEvent` table would duplicate state and create a new soft-delete
surface. The outbox already gives us at-least-once + dedupe via
`event.id`. `mention.received` events live in `outbox_events` with
`aggregateType="user"`, `aggregateId=mentionedUserId`, so the dispatcher
can fan out per-user without joining back to messages.

### Switchover scripts are operator-driven, not webhook-driven

`scripts/setup/*.sh` are NOT triggered by the webhook. They run by
hand on first install and during disaster recovery. The webhook is
strictly for ongoing deploys. This separation keeps the bootstrap
phase debuggable (you can run each step + read the output) and avoids
the "webhook is needed to install the webhook" chicken-and-egg.

### CI uses service containers for `test:int`, full compose for `test:e2e`

`test:int` only needs postgres + redis. GitHub Actions service
containers are the cheapest fit. `test:e2e` needs the actual API
server + web build serving over HTTP, so it runs `docker compose up`.
The two are split so a failing E2E doesn't block integration feedback.

## Non-goals

- Changing how mentions are parsed. The 004 parser is fine.
- Adding a notifications inbox page. Sidebar badge + toast + jump
  link is the MVP. A standalone `/notifications` page is a future
  task.
- Cron / systemd for the switchover scripts. They're explicitly
  one-shot.

## Risks

- **DinD on GitHub Actions runners.** `ubuntu-latest` ships docker
  and the daemon socket, so testcontainers should work. If
  testcontainers refuses to start (ryuk on a containerized runner is
  the historical pain point), set `TESTCONTAINERS_RYUK_DISABLED=true`
  matching the local NAS pattern. Fallback: refactor `test:int` to
  use service containers directly (drop testcontainers entirely);
  this is more work and lives in `Risks` not `Scope`.
- **Browser Notification API in dev.** HTTP `localhost` works in
  Chrome, blocked in Firefox. Toast-only fallback when
  `Notification.permission !== 'granted'`. E2E targets toast +
  sidebar badge, not the OS notification (those are
  browser-controlled).
- **Nginx diff auto-applies into a shared file.** Other apps' server
  blocks live in the same `nginx.conf`. The script must be additive
  (insert before the closing `}` of the `http {` block), never
  rewrite the file. The `nginx -t` gate + auto-rollback is the
  safety net but not infallible — operator runs it during a quiet
  hour.
- **`prod-reload.sh` sourcing `lock.sh` changes its behavior.** The
  manual path now blocks if a webhook deploy is in flight.
  Acceptable because that's the actual fix to the lying runbook.
  Document in `runbook-deploy.md` so the operator knows why
  `prod-reload.sh` may pause.
- **Mention fan-out at scale.** 100 mentions in `@everyone` style
  abuse → 100 toasts in 1s. Throttle covers this; metric records
  drops so the abuse is visible. A real `@everyone` requires a
  permission gate that's TODO(task-016).
- **Direct-merge bypasses PR review by humans.** Reviewer subagent
  is the substitute. If the reviewer raises any BLOCKER, fix forward
  and re-spawn before merging. If reviewer disagrees with the
  implementer twice, surface to user before merging.

## Progress Log

_Implementer fills this section during UNDERSTAND → REPORT, one
bullet per Agent Loop stage. Same shape as task-010 progress log._

- [ ] UNDERSTAND
- [ ] PLAN approved
- [ ] SCAFFOLD
- [ ] IMPLEMENT (A / B / C / D as four commit groups)
- [ ] VERIFY (`pnpm verify` attached + GHA runs green)
- [ ] OBSERVE (mention metric visible, switchover dry-run captured,
      CI artifact uploaded)
- [ ] REFACTOR
- [ ] REPORT (PR.md written, reviewer spawned, evals added,
      direct-merge to develop performed)
