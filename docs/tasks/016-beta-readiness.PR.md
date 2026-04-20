# Task 016 PR — Beta Readiness: deploy-hook SQL + Operator Tools + Priority Hygiene

**Branch:** `feat/task-016-beta-readiness`
**Base:** `develop` (`d12c22e`)
**Merge style:** direct `git merge --no-ff` to develop (convention since 011)
**Memory:** `feedback_skip_pr_direct_merge.md`, `feedback_retain_feature_branches.md`, `feedback_handoff_must_include_report.md`, `feedback_minio_naming.md`

## Summary

- **A** — deploy-hook SQL that closes task-015-follow-1:
  - `scripts/deploy/sql/task-015-message-search-concurrent.sql` rebuilds the two FTS indexes with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. Plain `CREATE INDEX` in task-015's migration would have taken an AccessExclusive lock on `Message` on populated prod.
  - `auto-deploy.sh` now iterates `scripts/deploy/sql/*.sql` after `prisma migrate deploy`. Each file pipes through `psql -v ON_ERROR_STOP=1` running inside the postgres container (no transaction wrap → CONCURRENTLY is legal). A failing hook aborts the deploy **before** rollout so prev containers stay live.
  - `docs/ops/runbook-deploy.md` gains a "Deploy-hook SQL" section: when to add one, the required shape (idempotent, no BEGIN), recovery after a mid-run failure, pre-push smoke command.
- **B** — 7 priority hygiene items:
  - `visibleChannelIds` folded from O(channels) `resolveEffective` loop into two batched queries + in-memory PermissionMatrix pass. SearchService dropped its ChannelAccessService dep. (015-follow-2)
  - Search SQL wraps the base match in a CTE so `ts_rank` evaluates once per row; cursor predicate + ORDER BY both reference the aliased `rank`. (015-follow-3)
  - CommandPalette a11y combobox pattern + ChannelList Button-primitive focus-visible ring were already correct at merge time — status rows updated in review.md. (010-follow-1 / 010-follow-2)
  - Task-011 doc reconciled: the "drop integration.yml + e2e.yml placeholders" bullet now correctly states those two were rewritten (not dropped) while `deploy-prod.yml` / `deploy-staging.yml` / `db-migrate.yml` (the K8s placeholders) were the ones actually removed. (011-follow-9)
  - `withSpan()` now sanitizes `attrs` through the `redactedAttributes.forbidden` set so accidentally passing PII-ish keys drops the value before OTEL sees it. (009-nit-2)
  - Outbox dispatcher + record + outbox-to-ws subscriber run `event_type` through `metrics.bucket(...)` against new `outboxEventType` / `wsEventType` allowlists. Unknown event types fall back to `_other` so cardinality stays bounded. (009-nit-4)
- **C-1** — Onboarding checklist:
  - GET `/me/onboarding-status` returns four simple counts (workspaces, channels-on-first-workspace, invitesIssued, messagesSent) in parallel. Cached 5 min.
  - `OnboardingCard.tsx` renders at sidebar top with ✅/⬜ gating + manual ✕. Auto-dismiss (localStorage `qufox.onboarding.dismissed=true`) when all four are green.
  - Cache key includes `viewer.id` so cross-user state never leaks.
- **C-2** — Closed-beta signup gate:
  - `BetaInviteRequiredGuard` on POST /auth/signup. `BETA_INVITE_REQUIRED=true` → rejects 403 `BETA_INVITE_REQUIRED` without a valid body `inviteCode`. Guard validates against the existing Invite table (exists, not revoked, not expired, uses remaining). Signup does **not** consume the invite — `/invites/:code/accept` still runs post-signup.
  - `SignupDto` gains optional `inviteCode`.
  - `main.ts` boot-time WARN when `NODE_ENV=production` + flag not `true` (not a crash — public demo is a valid use case).
  - `ErrorCode` + shared-types `ErrorCodeSchema` + `.env.prod.example` all gain the flag.
  - `scripts/setup/init-admin.sh` bootstraps the first admin; reads email/password/username from stdin (never env — avoids `docker inspect` leak), auto-detects TTY vs `--stdin` mode. Shells into qufox-api + POSTs /auth/signup with a per-call `BETA_INVITE_REQUIRED=false` override. Idempotent on email-taken (409 → exit 0).
- **C-3** — Feedback widget:
  - Migration `20260425000000` adds `Feedback` table + `FeedbackCategory` enum (BUG/FEATURE/OTHER). Content is TEXT with DB-level CHECK `char_length <= 2000`. FKs to User/Workspace are ON DELETE SET NULL for GDPR-style user purge continuity.
  - `POST /feedback` (JwtAuthGuard + 5/hour/user rate limit). Category defaults OTHER on missing input. `page` from Referer header (500-char slice), `userAgent` from UA header.
  - `FeedbackDialog` (💬 button in BottomBar → Dialog with category select + textarea + live counter). Success toast; failure keeps form open for retry.
  - No admin UI — operator uses `SELECT * FROM "Feedback" ORDER BY "createdAt" DESC LIMIT 50;`.
- **C-4** — DAU/MAU gauge:
  - New `qufox_active_users{window="1d|7d|30d"}` Prometheus gauge on MetricsService.
  - `ActiveUsersCollector` ticks hourly (setInterval) + once on module init (60s delayed to let the pool settle). One UNION-ALL query returns the three distinct-user counts from `RefreshToken.createdAt`.
  - `RefreshToken` rotation already writes a new row each `/auth/refresh` call so `createdAt` is functionally equivalent to a `lastUsedAt` column without the extra UPDATE.
  - Unit spec covers the happy path + the informational-only failure path.

## Verify

```
pnpm verify → green
```

Tasks: 19/19 success, 0 errors.

- `@qufox/api:typecheck` ✓
- `@qufox/api:test` ✓ (+ `active-users-collector.unit.spec.ts`: 2 tests)
- `@qufox/webhook:test` ✓
- `@qufox/shared-types:test` ✓
- `@qufox/web:test` ✓ (17 tests, no new but no regressions)
- `@qufox/web:typecheck` ✓

## Migration

`apps/api/prisma/migrations/20260425000000_add_feedback_table/` — additive. Down script destructive (feedback rows lost, enum dropped); acceptable for dev/test, documented in the migration header.

Alongside: `scripts/deploy/sql/task-015-message-search-concurrent.sql` runs on every deploy after the migration; the `IF NOT EXISTS` guards make the populated-prod and fresh-install cases both no-ops when the FTS indexes already match.

## Commits

```
42ddb98 feat(observability): task-016-C-4 — DAU/WAU/MAU gauge from refresh-token rotation
6d87eaf feat(feedback): task-016-C-3 — feedback widget + POST /feedback + Feedback table
4c09a2b feat(beta-gate): task-016-C-2 — closed-beta signup gate + bootstrap admin script
d27ecbf feat(onboarding): task-016-C-1 — sidebar checklist card + GET /me/onboarding-status
53ed556 refactor(hygiene): task-016-B — 7 priority items
ba363fa feat(deploy): task-016-A — deploy-hook SQL directory + first hook for 015 FTS
566ab5a docs(task-016): beta readiness task contract
```

## Acceptance greps

- 0 lines for the 8 `TODO(task-...)` markers listed in the contract (verified after each chunk — all were doc-only and stay doc-only).
- Deploy-hook idempotency: `CREATE INDEX CONCURRENTLY IF NOT EXISTS` is idempotent by design; re-running the file on an already-indexed DB is a silent no-op.
- `init-admin.sh` idempotency: email-taken (409) returns exit 0 with a "nothing to do" log line.

## Risks

- `RefreshToken.createdAt` as a DAU proxy undercounts users who log in and leave within the 15-min rotation window. Documented granularity; alerting deferred until we know the threshold.
- No admin UI for feedback in this task. Operator queries by psql until volume justifies.
