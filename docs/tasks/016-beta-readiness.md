# Task 016 — Beta Readiness: deploy-hook SQL + Operator Tools + Priority Hygiene

## Context

By the end of task-015, all user-visible MVP features were live —
mention / attachment / ACL / reaction / thread / search — but the
operational layer needed to accept real beta users was missing:

- No first-time guidance for a user who just logged in.
- Anyone could sign up — unsuitable for a closed beta.
- No channel to collect user feedback.
- No usage metric (DAU / MAU) to see if the beta is alive.

There is also a blocking operational risk from 015:
`messages_search_tsv_idx` and `messages_content_trgm_idx` were
created with a plain `CREATE INDEX` in the Prisma migration. On a
populated prod database the next `prisma migrate deploy` would take
an `AccessExclusive` lock on `messages` for the index build
duration — the chat system goes dark. A `CREATE INDEX CONCURRENTLY`
run outside the transaction is required before that migration runs
against prod.

Task 016 lands all four beta-operations items, the deploy-hook SQL
patch, and cleans seven priority LOW/NIT hygiene items from the
deferred pile.

## Scope (IN)

### A. 015-follow-1 — deploy-hook SQL

- New file `scripts/deploy/sql/task-015-message-search-concurrent.sql`:

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_search_tsv_idx
    ON messages USING gin(search_tsv)
    WHERE deleted_at IS NULL;

  CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_content_trgm_idx
    ON messages USING gin(content gin_trgm_ops)
    WHERE deleted_at IS NULL;
  ```

  Runs **outside** the migration transaction, idempotent.

- `scripts/deploy/auto-deploy.sh` — extend to run
  `scripts/deploy/sql/*.sql` in alphabetical order after
  `prisma migrate deploy` succeeds. Each file is expected to be
  idempotent (`IF NOT EXISTS` / `IF EXISTS DROP` patterns).
- `docs/ops/runbook-deploy.md` — document the `scripts/deploy/sql/`
  hook: when to add one, what "idempotent" means in this context,
  recovery procedure if a hook SQL fails mid-run.
- Also ensure the **original** migration from 015 is marked as
  "applied" on prod before the hook runs, so there's no double
  build attempt.

### B. Priority hygiene cleanup (7 items)

UNDERSTAND grep-verifies each; live items get a 1-line fix and the
marker removed; already-fix-forward'd get only a review.md status
update.

| Item                                                                                                | Source       | Priority            |
| --------------------------------------------------------------------------------------------------- | ------------ | ------------------- |
| `visibleChannelIds` N+1 — fold into single SQL aggregate                                            | 015-follow-2 | LOW (perf)          |
| FTS cursor pagination re-evaluates `ts_rank` per row — rewrite cursor predicate                     | 015-follow-3 | LOW (perf)          |
| `CommandPalette` combobox a11y (`role="combobox"`, `aria-activedescendant`, `aria-expanded`)        | 010-follow-1 | LOW (a11y)          |
| `ChannelList` inline submit buttons get explicit `focus-visible:ring` via design-system primitive   | 010-follow-2 | LOW (UX)            |
| Task-011 doc reconcile — "drop placeholders" phrasing doesn't match what shipped                    | 011-follow-9 | LOW (doc)           |
| `redactedAttributes.forbidden` unused — enforce in `withSpan()` helper                              | 009-nit-2    | NIT (observability) |
| `outboxEventType` / `wsEventType` labels bypass `bucket()` — add them to the `L` helper's allowlist | 009-nit-4    | NIT (cardinality)   |

### C. Beta operator tools

#### C-1. Admin onboarding checklist card

- Sidebar top shows a "🚀 Beta setup" card (dismissible).
- Four automatic checks, re-evaluated on render:
  - [ ] Workspace created (`/me/workspaces.length >= 1`)
  - [ ] Second channel created (`channels.length >= 2`; the
        default channel counts as 1, so this marks "added one
        beyond default")
  - [ ] Invited a member (`issued_invites_count >= 1`)
  - [ ] Sent a first message (`messages_sent_by_me >= 1`)
- All checks green → card auto-hides (localStorage
  `qufox.onboarding.dismissed=true`). User can also close via X.
- Single endpoint `GET /me/onboarding-status` returns
  `{ workspaces, channels, invitesIssued, messagesSent }` —
  counts only, no row fetch. Cached 5 min in TanStack Query.
- Never reopens after dismissal (session-stable).

#### C-2. Invite-only signup (beta whitelist)

- New guard `BetaInviteRequiredGuard` on `POST /auth/signup`.
- Env `BETA_INVITE_REQUIRED`:
  - `true` (prod default) → signup requires a valid
    `inviteCode` in the body; rejected with 403
    `BETA_INVITE_REQUIRED` otherwise
  - `false` (dev/test default) → guard is a no-op
- Signup page UX: `/signup` without `?invite=<code>` shows
  "This is a closed beta. You need an invite link to join." with
  a support-email link.
- Bootstrap admin: new script `scripts/setup/init-admin.sh`
  (interactive — reads `ADMIN_EMAIL`, `ADMIN_PASSWORD` from stdin,
  never from env, to avoid `docker inspect` leak). Idempotent:
  if a user with the given email exists, prints a message and
  exits 0.
- `shared-types` adds `BETA_INVITE_REQUIRED` to `ErrorCodeSchema`.
- `init-env-deploy.sh` (from 011) — now emits
  `BETA_INVITE_REQUIRED=true` by default in `.env.deploy`.
- Boot-time assert: if `NODE_ENV=production` and
  `BETA_INVITE_REQUIRED` is unset/`false`, log a WARN (don't
  crash — the operator may have intentionally opened signup for
  a private demo).

#### C-3. Feedback widget

- Sidebar bottom adds "💬 Feedback" button.
- Click → modal with:
  - Category select: `bug` / `feature` / `other`
  - Textarea (max 2000 chars, character counter)
  - Submit button
- `POST /feedback` body `{ category, content }`. Server captures:
  - `userId`, `workspaceId` (the currently-active one), `category`,
    `content`, `page` (from `Referer` header), `userAgent`,
    `createdAt`
- Prisma `Feedback` table (new):
  ```
  id          uuid pk
  userId      uuid fk -> User.id ON DELETE SET NULL
  workspaceId uuid? fk -> Workspace.id ON DELETE SET NULL
  category    enum BUG | FEATURE | OTHER
  content     text (max 2000 at DB level too)
  page        text?
  userAgent   text?
  createdAt   timestamptz default now()
  ```
  Indexes: `(createdAt DESC)`, `(userId, createdAt DESC)`.
- Rate limit: 5 submissions / hour / user.
- Submit success → toast "피드백 감사합니다!"
- **No admin UI in this task** — operator runs
  `SELECT * FROM "Feedback" ORDER BY "createdAt" DESC LIMIT 50;`
  in `psql`. A UI becomes justifiable when volume grows.

#### C-4. DAU / MAU metric

- New collector `apps/api/src/observability/active-users.collector.ts`
  exports three Prometheus gauges:
  - `qufox_active_users{window="1d"}`
  - `qufox_active_users{window="7d"}`
  - `qufox_active_users{window="30d"}`
- Data source: `SELECT count(DISTINCT user_id) FROM
refresh_tokens WHERE last_used_at > now() - interval '<window>'`.
  Refresh-token usage ≈ session activity; lighter than
  audit_log.
- Cron: hourly (`@Interval(3600 * 1000)`) — Nest scheduler.
- Grafana dashboard (`infra/grafana/dashboards/*.json`) gains
  one panel: DAU vs MAU line chart over 30 days.
- No alerting on these (informational only).

## Scope (OUT) — future tasks

- Onboarding wizard / forced tutorial — out (checklist is enough).
- Feedback admin dashboard / filtering / response threads — out
  until volume justifies.
- Korean morphological analyzer (mecab-ko) — wait for traffic.
- Custom emoji upload — separate task.
- Loki self-hosted logs — TODO(task-019), do after first beta
  traffic lands and we have something to aggregate.
- PITR / WAL archiving — separate ops task.
- sops / age secret encryption — separate ops task.
- Per-IP signup rate-limit (beta-invite-required covers the
  abuse path).
- Bot detection / CAPTCHA.
- DAU/MAU alerting (we don't yet know the threshold).
- Feedback spam filtering — out; closed beta = low risk.
- Residual LOW/NIT (~8 items: 012-follow-2/6/7/8/11, 009 LOW/NIT
  residue) — defer.

## Acceptance Criteria (mechanical)

- `pnpm verify` green. Log attached to `docs/tasks/016-*.PR.md`.
- `pnpm --filter @qufox/api test:int` green on GitHub Actions.
  New specs:
  - `feedback.int.spec.ts` (submit + rate limit 5/hour +
    page/userAgent capture)
  - `beta-invite-guard.int.spec.ts` (signup blocked when
    `BETA_INVITE_REQUIRED=true` + inviteCode absent; allowed
    with valid code; allowed when guard disabled)
  - `active-users-collector.unit.spec.ts` (mocked DB count →
    expected Prometheus gauge value)
  - `onboarding-status.int.spec.ts` (each of the four counters
    returns expected values)
- `pnpm --filter @qufox/web test:e2e` green on GitHub Actions:
  - `onboarding-checklist.e2e.ts` (0 workspaces → 1 workspace →
    check flips; dismiss persists)
  - `feedback-widget.e2e.ts` (submit + toast + DB row created)
  - `beta-invite-required.e2e.ts` (without invite →
    safe-landing page; with invite → signup form)
- One Prisma migration, **reversible-first**:
  - `add_feedback_table.sql` + down. Down-script comment notes
    destructive (feedback rows lost).
- Deploy-hook SQL verified idempotent:
  - `bash -c 'psql < scripts/deploy/sql/task-015-message-search-concurrent.sql; psql < scripts/deploy/sql/task-015-message-search-concurrent.sql'` — both runs exit 0, no error.
- `bash scripts/setup/init-admin.sh` idempotent (double-run
  doesn't create duplicate admin).
- TODO regression guard:
  - `grep -rn 'TODO(task-015-follow-1\|TODO(task-015-follow-2\|TODO(task-015-follow-3\|TODO(task-010-follow-1\|TODO(task-010-follow-2\|TODO(task-011-follow-9\|TODO(task-009-nit-2\|TODO(task-009-nit-4' --include='*.ts' --include='*.tsx' --include='*.sh' .` returns **0 lines**.
- `BETA_INVITE_REQUIRED=true` boot-time assert produces a WARN
  log (not a crash).
- Three artefacts: `016-*.md`, `016-*.PR.md`, `016-*.review.md`.
- One eval added: `evals/tasks/031-beta-onboarding.yaml`.
- Reviewer subagent **actually spawned**; transcript token count
  recorded in review.md header.
- **Direct merge to develop** (PR creation skipped). Commit
  message: `Merge task-016: beta readiness + deploy-hook SQL + hygiene`.
- **REPORT printed to chat automatically** after merge.
- Feature branch retained.

## Prerequisite outcomes

- 015 merged to develop (`d12c22e`).
- `auto-deploy.sh` (009) — confirm `prisma migrate deploy`
  invocation location; the new SQL-hook loop attaches just
  after.
- 002 invite system still issues codes that `BetaInviteRequiredGuard`
  can validate against.
- 010/011 follow-ups that the B chunk references — verify live
  via grep.
- `refresh_tokens.lastUsedAt` column exists and is maintained
  on every refresh (audit first — it may be lazily written).

## Design Decisions

### Beta whitelist = invite-only signup

No separate whitelist table or admin UI. The workspace-invite
system from 002 is the whitelist: you can only sign up if
someone sent you an invite link. Admins are workspace OWNERs
and issue invites through the UI that already exists. The only
bootstrap is `init-admin.sh` for the very first user.

### Onboarding is a checklist card, never a modal

Beta users who see a forced wizard on first login will
remember friction, not the product. A sidebar card that
self-dismisses when satisfied is the minimum-interruption shape.
If the user already has a workspace (invited in), most of the
boxes start checked.

### Deploy-hook SQL pattern, not migration chain

Prisma migrations run inside a transaction; `CREATE INDEX
CONCURRENTLY` forbids transactions. Rather than fight Prisma,
add a separate hook directory. Alphabetical run order means new
hooks land without registration; idempotency (`IF NOT EXISTS`)
lets rerun be free. Clear separation: migrations = DDL that
lives in a transaction; hooks = DDL that can't.

### No admin UI for feedback yet

Adding `/admin/feedback` means another route, permission check,
pagination, filter — cost for a need we haven't seen. `psql` is
fine while volume is 1–50 submissions. UI becomes worth it when
a human can't read the whole queue in an hour.

### DAU/MAU from `refresh_tokens`

`refresh_tokens.lastUsedAt` is the lightest truth for "is this
user actively using the app?" — updated on every token refresh
(so once every 15 min per active user). `audit_log` is more
accurate but heavier. In beta volume, a 15-min-granularity DAU
is fine; when we need minute-level, move to audit_log or
WebSocket presence.

## Non-goals

- Wizard / tutorial flow.
- Admin dashboards (feedback, DAU drill-down, etc.).
- Abuse defense (CAPTCHA, bot detection).
- Feedback triage / response workflow.

## Risks

- **`init-admin.sh` interactive mode on a headless NAS** — if the
  operator SSHes in without a TTY, stdin prompts fail. Mitigate:
  script detects non-TTY and falls back to reading from a
  one-shot temp file whose path is passed as arg — operator
  creates the file, runs, deletes. Document in runbook.
- **`GET /me/onboarding-status` cache poisoning across users** —
  TanStack Query caches by query-key; the key includes
  `viewer.id` so no cross-user leak. Test with two sessions.
- **Deploy-hook SQL fails mid-run** — one index created, second
  fails (e.g. out of disk). The second run completes the first
  (IF NOT EXISTS is noop) and reattempts the second. No manual
  intervention needed — that's the idempotency point.
- **`BETA_INVITE_REQUIRED` disabled in prod by accident** —
  boot-time WARN instead of crash, because a legit reason
  (public demo) exists. Alert reviewer if they want harder
  enforcement; for now the WARN is a paper trail.
- **Feedback rate limit 5/hour is tight for enthusiastic users** —
  5/hour was chosen to prevent accidental double-submits. If
  reviewer pushes back, raise to 10/hour. Abuse resistance
  comes from invite-only anyway.
- **`refresh_tokens.lastUsedAt` updated lazily** — if the column
  is written only on token-rotate (every 15 min per active
  user), DAU undercounts users who logged in then left within
  15 min. Acceptable granularity; document.
- **Onboarding card render cost** — four counts per render, each
  a simple `count(*)`. Cache 5 min. Index `(userId)` on
  `WorkspaceMember`, `Message`, `Invite` already exists from
  earlier tasks. EXPLAIN the aggregate to confirm no seq scan.
- **Feedback `content` leakage into logs** — the request body
  must NOT be logged (contains user text, possibly PII).
  ensure the logger interceptor from 007 is skipping
  `POST /feedback` body — add test.
- **`scripts/deploy/sql/` directory doesn't exist yet** — create
  empty directory in the A commit so the `ls` in
  `auto-deploy.sh` finds it; add a `.gitkeep`.

## Progress Log

_Implementer fills this section. Three top-level commit groups
(A hook, B hygiene, C operator tools) with C split into four
sub-commits (C-1 onboarding, C-2 invite gate, C-3 feedback,
C-4 DAU)._

- [ ] UNDERSTAND (hygiene grep, refresh_tokens.lastUsedAt audit,
      auto-deploy.sh prisma-migrate location, 002 invite API
      surface)
- [ ] PLAN approved
- [ ] SCAFFOLD (feedback migration red, BetaInviteRequiredGuard
      stub, deploy-hook directory skeleton)
- [ ] IMPLEMENT (A → B → C-1 → C-2 → C-3 → C-4)
- [ ] VERIFY (`pnpm verify` after each + GHA green)
- [ ] OBSERVE (deploy-hook dry-run; DAU cron fires once, gauge
      visible at `/metrics`; onboarding card flips in E2E)
- [ ] REFACTOR
- [ ] REPORT (PR.md, reviewer spawned, eval added, direct merge,
      **REPORT printed automatically**)
