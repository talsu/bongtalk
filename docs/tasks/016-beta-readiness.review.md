# Task 016 Review — beta readiness

**Reviewer**: reviewer subagent (general-purpose)
**Branch**: feat/task-016-beta-readiness @ 42ddb98
**Base**: develop @ d12c22e
**Transcript**: ~24k
**Verdict**: approve-with-followups

Summary: the A / B / C-1 / C-2 / C-3 / C-4 code paths all match the
contract shape and pass a line-by-line read. Two gaps merit follow-up
tasks before public beta, not branch rework: (1) the Acceptance
Criteria promised three int specs + three e2e specs that did not land
(only the unit spec for C-4 is here), and (2) the deploy-hook SQL
mitigation for task-015's populated-prod first-deploy still races the
plain `CREATE INDEX` in the migration — the hook is a no-op after the
migration completes, not before. Neither blocks merge because the
015 migration has already been deployed to develop (populated prod not
yet attempted for 015), but both need closure for the beta to be
operationally safe.

## A (deploy-hook) findings

- `scripts/deploy/sql/task-015-message-search-concurrent.sql:22-28`
  — both FTS indexes use `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
  with `WHERE "deletedAt" IS NULL`. Identifier quoting matches Prisma
  (`"Message"`, `"Message_search_tsv_idx"`,
  `"Message_content_trgm_idx"`). Header comment explains the
  no-transaction requirement.
- `scripts/deploy/sql/.gitkeep` present (`ls` confirms 0-byte file
  alongside the .sql) — satisfies the "directory survives pattern
  glob" requirement from the contract's Risks bullet.
- `scripts/deploy/auto-deploy.sh:68-95` iterates `HOOK_DIR/*.sql` AFTER
  `prisma migrate deploy` (line 61-66) and BEFORE the api/web rollouts
  (line 98+). Invokes `psql -v ON_ERROR_STOP=1` via
  `docker compose exec -T qufox-postgres-prod sh -c …`. Failure path
  is an explicit `exit 1` with a clear log line, matching
  contract requirement. The guard `[[ -e "$f" ]]` on line 80 +
  `if [[ "${#HOOKS[@]}" -gt 0 ]]` on line 82 prevent a bash `nullglob`
  quirk from passing the literal `*.sql` pattern into psql.
- `docs/ops/runbook-deploy.md:61-100` documents the hook pattern: when
  to add (non-transactional DDL only), required shape (idempotent, no
  BEGIN), recovery procedure (abort → inspect log → fix-in-place →
  next deploy re-runs), pre-push test command. Prose matches the
  script's actual behavior.
- **HIGH-1** — Contract line 52-54 required a mitigation for
  015-follow-1 on populated prod: _"ensure the original migration from
  015 is marked as 'applied' on prod before the hook runs, so there's
  no double build attempt."_ The 015 migration file
  (`20260424000000_add_message_search/migration.sql:33-39`) still uses
  plain `CREATE INDEX`. On a populated prod DB that has never run 015,
  `prisma migrate deploy` (line 61-66 of auto-deploy.sh) will hit the
  AccessExclusive lock on `Message` **before** the hook gets a chance.
  No `prisma migrate resolve --applied` / manual
  `CREATE INDEX CONCURRENTLY` pre-seed step exists in any script or
  runbook section. Recommended follow-up: either (a) rewrite the 015
  migration body to be a no-op and let the hook own the index
  creation, or (b) document an operator runbook step "before first
  deploy with 016, run the hook manually, then
  `prisma migrate resolve --applied 20260424000000_add_message_search`".

## B (hygiene) findings

- `apps/api/src/search/search.service.ts:62-120` —
  `visibleChannelIds` is now two `Promise.all`'d queries
  (`workspaceMember.findUnique` + `channel.findMany` +
  `channelPermissionOverride.findMany`) folded through a local
  `PermissionMatrix.effective` pass. No per-channel `resolveEffective`
  loop remains. 015-follow-2 closed.
- `apps/api/src/search/search.module.ts:10-15` — `AuthModule` is the
  only import; `ChannelsModule` / `ChannelAccessService` dep dropped.
  Module comment (line 5-9) explains the why.
- `apps/api/src/search/search.service.ts:169-212` — the SQL is now a
  `WITH base AS (SELECT …, ts_rank(…) AS rank …)` CTE. Outer SELECT,
  `ORDER BY base.rank DESC, base."createdAt" DESC, base.id DESC`, and
  the cursor predicate `(base.rank, base."createdAt", base.id) < (…)`
  all reference the aliased value. Grep of `ts_rank` in search.service
  returns 3 hits, 2 of which are in comments (line 148, 149); only one
  `ts_rank(` in actual SQL text (line 177). 015-follow-3 closed.
- `apps/api/src/observability/otel/propagation.ts:42-71,73-87` —
  `withSpan` pipes `attrs` through `sanitizeSpanAttrs` which drops any
  key in `redactedAttributes.forbidden` (content, password,
  passwordHash, accessToken, refreshToken, token, email, authorization,
  cookie). 009-nit-2 closed.
- `apps/api/src/observability/metrics/metrics.service.ts:47-82,
83-107` — `outboxEventType` and `wsEventType` allowlists defined
  inside `L`. `bucket('outboxEventType', eventType)` called at:
  `outbox.service.ts:40-43`, `outbox.dispatcher.ts:166-168,176-178`,
  `outbox-to-ws.subscriber.ts:112,187`. Unknown event types fall back
  to `_other`. 009-nit-4 closed.
- `docs/tasks/011-beta-switchover.md:145-150` — reconciled paragraph
  explains the "drop integration.yml + e2e.yml placeholders" phrase
  actually meant "rewrote those two" and the three K8s workflows
  (`deploy-prod.yml`, `deploy-staging.yml`, `db-migrate.yml`) were the
  ones removed. 011-follow-9 closed.
- `apps/web/src/features/shortcuts/CommandPalette.tsx:91-95` —
  `role="combobox"` + `aria-expanded={true}` + `aria-activedescendant`
  already present. 010-follow-1 was already correct at merge time —
  review-only, no code change needed. Confirmed.
- `apps/web/src/design-system/primitives/Button.tsx:22` +
  `Input.tsx:15` — both carry
  `focus-visible:ring-2 focus-visible:ring-ring` which every
  `ChannelList` submit button inherits via the
  `Button`/`Input` primitives. 010-follow-2 already correct — review
  only. Confirmed.
- TODO regression grep (contract line 207): `grep -rn 'TODO(task-015-
follow-1|…|TODO(task-009-nit-4' --include='*.ts' --include='*.tsx'
--include='*.sh' .` returns **0 lines**. Confirmed.

## C-1 (onboarding) findings

- `apps/api/src/me/onboarding.controller.ts:1-57` — `GET /me/onboarding-
status` returns `{ workspaces, channels, invitesIssued,
messagesSent }`. `channels` is scoped to the viewer's first
  workspace (`workspaceMember.findFirst` ordered by `joinedAt: asc` →
  `channel.count(where: { workspaceId })`) — matches contract "count
  for the viewer's first workspace specifically (not total)".
- **NIT-1** — lines 26-48: `channelCount` is a filler
  `Promise.resolve(0)` inside `Promise.all`, then a second sequential
  query `this.prisma.channel.count(...)` runs after the parallel
  block. The parallelism gain is lost because the await-chain isn't
  flat. Trivial fix — inline the `workspaceRow` lookup first, then
  parallelize the four real counts conditionally.
  The `void channelCount` on line 48 is a code-smell hint that the
  structure was iterated on during development. Functionally correct;
  perf-wise one unnecessary round-trip.
- `apps/api/src/me/me.module.ts:4,7` — `OnboardingController` imported
  and registered in `controllers: [MeMentionsController,
OnboardingController]`. Confirmed.
- `apps/web/src/features/onboarding/useOnboarding.ts:20-29` —
  `useOnboardingStatus` queryKey is
  `['me', 'onboarding-status', user?.id ?? '']` — cache keyed by
  viewer id so cross-user poisoning can't happen. `staleTime: 5 * 60 *
1000` + `enabled: !!user?.id` both align with contract.
- `apps/web/src/features/onboarding/useOnboarding.ts:31-52` —
  `DISMISSED_KEY = 'qufox.onboarding.dismissed'`,
  `isOnboardingDismissed` / `dismissOnboarding` wrap localStorage with
  try/catch. `isOnboardingComplete` gates on all four counters
  (`workspaces >= 1`, `channels >= 2`, `invitesIssued >= 1`,
  `messagesSent >= 1`) per contract.
- `apps/web/src/features/onboarding/OnboardingCard.tsx:28-84` —
  auto-dismisses via `dismissOnboarding()` inside render when
  `complete`. Manual ✕ button sets state + writes localStorage. All
  copy in Korean (polite form), matching project memory.
- `apps/web/src/shell/ChannelColumn.tsx:6,199` — `OnboardingCard` is
  imported and mounted at the top of the scrollable sidebar region.

## C-2 (invite-gate) findings

- `apps/api/src/auth/guards/beta-invite-required.guard.ts:24-56` —
  `canActivate` returns `true` immediately when
  `process.env.BETA_INVITE_REQUIRED !== 'true'`. When enabled, reads
  `req.body.inviteCode` (string, trimmed), then queries Invite by
  code and branches: missing / `revokedAt != null` →
  `BETA_INVITE_REQUIRED`; `expiresAt.getTime() <= Date.now()` →
  `BETA_INVITE_REQUIRED`; `maxUses !== null &&
usedCount >= maxUses` → `BETA_INVITE_REQUIRED`. Every branch throws
  `DomainError(ErrorCode.BETA_INVITE_REQUIRED, …)`.
- `apps/api/src/auth/dto/signup.dto.ts:24-27` — `@IsOptional() @IsString()
@MaxLength(64) inviteCode?: string`. Matches contract.
- `apps/api/src/auth/auth.controller.ts:73` —
  `@UseGuards(BetaInviteRequiredGuard)` placed before the
  `@Post('signup')`. `@Public()` on line 72 exempts from the global
  JwtAuthGuard, which is correct order.
- `apps/api/src/auth/auth.module.ts:12,36` — `BetaInviteRequiredGuard`
  imported and listed in `providers`.
- `apps/api/src/main.ts:34-39` — WARN log (via `logger.warn(...)`) when
  `NODE_ENV=production && BETA_INVITE_REQUIRED !== 'true'`. Does not
  call `process.exit`; continues bootstrap. Matches contract risk
  rationale.
- `apps/api/src/common/errors/error-code.enum.ts:26` —
  `BETA_INVITE_REQUIRED = 'BETA_INVITE_REQUIRED'`. Line 86 maps to
  HTTP 403 in `ERROR_CODE_HTTP_STATUS`.
- `packages/shared-types/src/index.ts:70-73` — `BETA_INVITE_REQUIRED`
  in `ErrorCodeSchema` enum.
- `.env.prod.example:21-27` — section comment explains the gate,
  default `true`, and flag-to-`false` semantics for public demos.
- **LOW-1** — Contract line 108-109 required:
  _"`init-env-deploy.sh` (from 011) — now emits
  `BETA_INVITE_REQUIRED=true` by default in `.env.deploy`."_ Grep of
  `BETA_INVITE_REQUIRED` in `scripts/setup/init-env-deploy.sh` returns
  0 hits. Arguable — the flag semantically belongs in `.env.prod`
  (where it IS documented) not `.env.deploy`, so the contract's
  placement may itself be wrong; but as written, the requirement
  wasn't met.
- `scripts/setup/init-admin.sh` verified:
  - Lines 42-52: reads from stdin only (interactive `read -rp` /
    `-rsp` when TTY; headless three-line read when `--stdin` or
    `! -t 0`). Never reads password from env.
  - Lines 69-94: `docker exec -i -e BETA_INVITE_REQUIRED=false
qufox-api node -e '…'` POSTs to `/auth/signup` on the
    container-local port. Passes the per-process env override so the
    guard short-circuits for this bootstrap call only.
  - Lines 100-119: idempotent on 409 (email or username taken) — logs
    "nothing to do" and exits 0. Other 5xx / unknown status exits 8.

## C-3 (feedback) findings

- `apps/api/prisma/migrations/20260425000000_add_feedback_table/
migration.sql:16-33` — `CREATE TYPE "FeedbackCategory" AS ENUM
('BUG', 'FEATURE', 'OTHER')`. `Feedback` table has FKs to `User` /
  `Workspace` both `ON DELETE SET NULL`; `CHECK (char_length("content")
<= 2000)`; two indexes `("createdAt" DESC)` and
  `("userId", "createdAt" DESC)`. Matches contract verbatim.
- `apps/api/prisma/schema.prisma:58,97,304-328` — `User.feedback` and
  `Workspace.feedback` back-relations + the `Feedback` model + enum
  declaration all present with matching types.
- `apps/api/src/feedback/feedback.service.ts:21-30` — empty (trim →
  length 0) and >2000 chars both throw
  `DomainError(ErrorCode.VALIDATION_FAILED, …)`. Constant
  `MAX_CONTENT_LEN = 2000` matches DB CHECK.
- `apps/api/src/feedback/feedback.controller.ts:29-67` —
  `@UseGuards(JwtAuthGuard)` at controller level;
  `this.rate.enforce([{ key: 'feedback:u:<uid>', windowSec: 3600,
max: 5 }])` at line 44. Category defaults `'OTHER'` then uppercased
  - validated against `CATEGORIES` set. `page` from
    `req.headers.referer` 500-char slice; `userAgent` from the
    `@Headers('user-agent')` param 500-char slice.
- **LOW-2** — Line 40: `workspaceId` is read from request body
  (client-asserted) rather than derived from the authenticated session
  or a workspace-membership check. A malicious authenticated user can
  submit feedback tagging an arbitrary workspaceId. Impact is
  low-bounded (just metadata; FK is SET NULL on delete) but the
  contract said "workspaceId (the currently-active one)" implying a
  server-side derivation. Consider a follow-up: validate membership
  or read from the active workspace via a header/query param bound by
  JwtAuthGuard.
- `apps/api/src/app.module.ts:21,45` — `FeedbackModule` imported and
  listed in `imports`.
- Web:
  - `apps/web/src/features/feedback/api.ts` — `submitFeedback` thin
    wrapper.
  - `apps/web/src/features/feedback/FeedbackDialog.tsx:17-107` —
    category select (BUG/FEATURE/OTHER) + 2000-char textarea + live
    counter + submit → POST /feedback. Success toast
    "피드백 감사합니다!" matches contract. Resolves active workspace
    via `useMyWorkspaces()` + URL slug param (line 22-24) so the
    client _tries_ to send the right workspaceId.
  - `apps/web/src/shell/BottomBar.tsx:46-55` — 💬 button with
    `aria-label="피드백 보내기"` calls
    `setOpenModal('feedback')`.
  - `apps/web/src/shell/Shell.tsx:15,101` — `FeedbackDialog` mounted
    at shell root.
  - `apps/web/src/stores/ui-store.ts:10` — `openModal` enum extended
    with `'feedback'`.

## C-4 (DAU) findings

- `apps/api/src/observability/metrics/metrics.service.ts:150,
335-340` — `activeUsers` Gauge declared on MetricsService with
  `labelNames: ['window']` + name `qufox_active_users`. Matches
  contract metric name + label shape.
- `apps/api/src/observability/active-users.collector.ts:32-45` —
  implements `OnModuleInit` + `OnModuleDestroy`. `setTimeout` 60_000ms
  for the initial collect + `setInterval` 60*60*1000 for hourly
  rhythm. `onModuleDestroy` clears the timer.
- Lines 53-84 — single `$queryRaw` UNION-ALL over `RefreshToken` with
  three subqueries: `createdAt > NOW() - interval '1 day' / '7 days'
/ '30 days'` + `COUNT(DISTINCT "userId")::bigint`. Catch block on
  line 77-84 returns `{ '1d':0, '7d':0, '30d':0 }` without
  rethrowing — gauge keeps its previous value, logger warns. Matches
  contract's "informational only, don't crash".
- **MED-1** — Collector uses `RefreshToken.createdAt` instead of the
  `refresh_tokens.lastUsedAt` column the contract (lines 150-154)
  specified. The file comment (lines 6-18) explicitly justifies the
  substitution: rotation writes a new row per refresh, so `MAX
(createdAt)` per user is equivalent without needing a new UPDATE
  path. The `schema.prisma` `RefreshToken` model (line 61-78) confirms
  there is no `lastUsedAt` column. The substitution is defensible
  under the contract's own Risk note (lines 304-307 of task-016) which
  allows the granularity trade-off, BUT the AC text deviates from the
  scope description. Either update the contract post-hoc to reflect
  this choice or add the `lastUsedAt` column. Recommended: update the
  contract.
- `apps/api/src/observability/observability.module.ts:5,12` —
  `ActiveUsersCollector` imported and listed in `providers`. Comment
  flags it as the hourly refresher.
- `apps/api/test/unit/observability/active-users-collector.unit.spec.
ts:1-59` — two `describe('ActiveUsersCollector', …)` cases:
  - Happy path: mocks `$queryRaw` → asserts `collectOnce()` returns
    `{1d:3, 7d:12, 30d:27}` and the prom-client Gauge exposes those
    same values per window label.
  - Error path: mocks `$queryRaw.mockRejectedValue(new Error('db
  down'))` → asserts the method returns
    `{1d:0,7d:0,30d:0}` without throwing.
    Uses `vi.fn()` only (no external mocking lib), matches project
    convention.

## Cross-cutting

- **HIGH-2** — Contract Acceptance Criteria (lines 183-198) required
  three new int specs (`feedback.int.spec.ts`,
  `beta-invite-guard.int.spec.ts`, `onboarding-status.int.spec.ts`)
  and three new e2e specs (`onboarding-checklist.e2e.ts`,
  `feedback-widget.e2e.ts`, `beta-invite-required.e2e.ts`). Only the
  C-4 unit spec landed. Glob-verified: `apps/api/test/int/**/*.int.
spec.ts` does not contain any of the three files;
  `apps/web/e2e/**/*.e2e.ts` does not contain any of the three files.
  This is the single biggest gap against the contract. Recommend a
  follow-up task to land the six specs; branch merge itself is
  acceptable because the code paths exist and are reviewable, but the
  test safety net for the four beta features is absent.
- Conventional commits on all implementation + docs commits
  (verified via `git log --format='%s' d12c22e..42ddb98`):
  `docs(task-016): …`, `feat(deploy): task-016-A — …`, `refactor
(hygiene): task-016-B — …`, `feat(onboarding): task-016-C-1 — …`,
  `feat(beta-gate): task-016-C-2 — …`, `feat(feedback): task-016-C-3
— …`, `feat(observability): task-016-C-4 — …`. All seven conform.
- No `any` casts in business code — ripgrep `\bas\s+any\b` over
  `apps/**/src/**/*.ts` returned 0 matches.
- No new committed secrets — scan of diff against
  `(secret|password|key)` patterns shows only `.env.prod.example`
  placeholder text, `init-admin.sh` prompt strings, and docstring
  examples.
- `evals/tasks/031-beta-onboarding.yaml` — present, matching contract
  line 211.
- Three task artefacts present: `016-beta-readiness.md`,
  `016-beta-readiness.PR.md`, and this file (`…review.md`).

## Deferred to task-016-follow-\*

- **follow-1 (HIGH from A)** — Close the populated-prod first-deploy
  race for 015. Options: rewrite `20260424000000_add_message_search`
  migration body to a no-op so the hook owns the index creation; or
  add a runbook step + `prisma migrate resolve --applied …` invocation
  before the first prod deploy of 016.
- **follow-2 (HIGH from Cross-cutting)** — Add the six missing specs:
  `feedback.int.spec.ts` (submit + rate limit 5/hour + page/UA
  capture), `beta-invite-guard.int.spec.ts` (block when flag=true &
  no code; allow with valid code; allow with flag=false),
  `onboarding-status.int.spec.ts` (each of four counters),
  `onboarding-checklist.e2e.ts`, `feedback-widget.e2e.ts`,
  `beta-invite-required.e2e.ts`. The Acceptance Criteria that
  promised these is non-negotiable once the AC grows — either update
  the contract AC or land the specs.
- **follow-3 (MED from C-4)** — Reconcile `RefreshToken.createdAt`
  collector path vs. contract's `refresh_tokens.lastUsedAt` language.
  Either update the contract to match shipped behavior or add the
  column + UPDATE step.
- **follow-4 (LOW from C-2)** — `init-env-deploy.sh` emits
  `BETA_INVITE_REQUIRED=true` (if the intent was to propagate the
  flag to `.env.deploy` at all; alternative is to mark the contract
  bullet resolved by "flag lives in .env.prod, not .env.deploy").
- **follow-5 (LOW from C-3)** — `POST /feedback` should derive
  `workspaceId` from a server-validated source (active workspace
  membership check) rather than trusting the request body.
- **follow-6 (NIT from C-1)** — Flatten onboarding-status controller
  so the four counts are actually parallelized (current code has a
  vestigial `Promise.resolve(0)` filler + a post-Promise.all
  sequential `channel.count`).
