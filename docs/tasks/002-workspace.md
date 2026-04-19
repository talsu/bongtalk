# Task 002 — Workspace Module: CRUD / Members / Roles / Invites

## Context
Builds the multi-tenancy boundary that every follow-up domain module
(Channels, Messages, Realtime) leans on. Extends Task 001's auth spine by
adding workspace-scoped guards, roles (OWNER/ADMIN/MEMBER), and invite
acceptance. Decision — **Soft delete with 30-day grace**; hard purge deferred
to a future batch job (TODO task-014).

## Scope (IN)
- Workspace CRUD by slug, with soft delete + explicit `restore` endpoint.
- Members: list, role change (ADMIN↔MEMBER), admin removes member, self-leave,
  owner-transfer inside a single Prisma `$transaction`.
- Invites: create (OWNER/ADMIN only), list, revoke, public preview, accept
  with race-safe compare-and-swap on `usedCount`.
- Two-layer guard chain: `WorkspaceMemberGuard` (member lookup + `req.workspace`
  and `req.workspaceMember` injection) then `WorkspaceRoleGuard` (pure rank
  compare on cached member).
- Frontend: React-Query hooks, `/w/new`, `/w/:slug`, `/invite/:code` routes,
  workspace switcher, members list, role dropdown, invite link dialog.
- Unit / Integration (Testcontainers, 1 stack) / E2E (dockerised Playwright).
- Static guard-coverage check (`scripts/check-guard-coverage.ts`) runs in
  CI-ready form — 12/12 `:id` routes guarded.
- Prerequisite cleanup from Task-001: unified SWC pipeline (build + vitest +
  dev runtime) + `nodemon` watch mode (~2.4s restart).

## Scope (OUT) — future tasks
- Channels (Task-003), Messages (Task-004), Realtime WS broadcast (Task-005).
- Channel-level permission override → TODO(task-016).
- Audit log storage → TODO(task-015).
- Invite hard-delete purge batch → TODO(task-014).
- Workspace icon upload (S3) → TODO(task-017).
- Billing / plan / member caps → TODO(task-018).

## Acceptance Criteria (mechanical)
1. `pnpm dev` watch restart ≤ 2.4s on a trivial save.
2. `pnpm build && node apps/api/dist/main.js` boots and serves `/healthz`.
3. `pnpm -w run verify` exit 0.
4. `pnpm --filter @qufox/api test:int` exit 0 — includes
   `permissions.matrix.int.spec.ts` (55 cases), `invites.int.spec.ts`
   (including 10-concurrent race), and `workspaces.int.spec.ts` (soft delete,
   transfer ownership single-OWNER invariant).
5. `pnpm --filter @qufox/web test:e2e` via dockerised Playwright → 7/7 pass.
6. `pnpm smoke` extended: signup → ws create → invite create → accept → list members.
7. `pnpm audit --prod --audit-level=high` → 0 high/critical.
8. `scripts/check-guard-coverage.ts` → `12/12 routes guarded` exit 0.
9. `.env.example` gains `INVITE_CODE_BYTES`, `WORKSPACE_SOFT_DELETE_GRACE_DAYS`.
10. `docs/tasks/002-workspace.md` (this file) with Progress Log + matrix.
11. `evals/tasks/005-workspace-permission-matrix.yaml` +
    `evals/tasks/006-invite-accept-race.yaml` added, `pnpm eval --dry-run` → 6 tasks green.
12. Migration: `20260419092545_add_workspace_invites_members_v2`. Reversible notes
    in report (drop RefreshToken columns is manual down-migration).
13. Reviewer subagent spawned and notes captured.

## Permission Matrix (single source of truth)

Authoritative data lives in
`apps/api/test/int/workspaces/permission-matrix.data.ts`; the
table below reflects that data verbatim.

| Endpoint | Anon | Non-member | Member | Admin | Owner |
|---|---|---|---|---|---|
| POST /workspaces | 401 | 201 | 201 | 201 | 201 |
| GET /workspaces/:id | 401 | 404 NOT_MEMBER | 200 | 200 | 200 |
| PATCH /workspaces/:id | 401 | 404 | 403 INSUFFICIENT | 200 | 200 |
| DELETE /workspaces/:id | 401 | 404 | 403 | 403 | 202 |
| GET /workspaces/:id/members | 401 | 404 | 200 | 200 | 200 |
| PATCH /workspaces/:id/members/:uid/role | 401 | 404 | 403 | 200 | 200 |
| DELETE /workspaces/:id/members/:uid | 401 | 404 | 403 | 204 | 204 |
| POST /workspaces/:id/members/me/leave | 401 | 404 | 204 | 204 | 409 OWNER_MUST_TRANSFER |
| POST /workspaces/:id/transfer-ownership | 401 | 404 | 403 | 403 | 200 |
| POST /workspaces/:id/invites | 401 | 404 | 403 | 201 | 201 |
| GET /workspaces/:id/invites | 401 | 404 | 403 | 200 | 200 |

Public routes (not in the matrix — auth-optional):
- `GET /invites/:code` — preview; 200 / 404 NOT_FOUND / 410 EXPIRED / 410 EXHAUSTED.
- `POST /invites/:code/accept` — auth required; 201 / 409 ALREADY_MEMBER / 410.

## Non-goals
- Channel / message ACL overrides (Task-003+).
- Real-time broadcasts (Task-005).
- Audit log persistence.

## Risks
- **Prisma $executeRawUnsafe in invite accept** — we use a hand-crafted UPDATE
  for the compare-and-swap on `usedCount`. This is safe because all inputs are
  bound parameters (`$1`, `$2`), but downstream maintainers must preserve that.
- **Soft delete leakage** — queries that forget `where: { deletedAt: null }`
  will surface deleted workspaces. Tests cover list + get; channel/message
  modules must extend this invariant.
- **Testcontainers on Synology** — first-time pulls + migrate can push int
  tests to ~50s. `TESTCONTAINERS_RYUK_DISABLED=true` remains set.

## Progress Log
- `planner` — plan + permission matrix + soft-vs-hard options emitted; user
  picked Soft; task-001 merged to main as base.
- `db-migrator` — schema diff + migration `add_workspace_invites_members_v2`
  (Workspace adds desc/iconUrl/deletedAt/deleteAt + indexes; WorkspaceMember
  switched to composite PK; Invite gains maxUses/usedCount/revokedAt). Reset
  pattern used: the only destructive change (composite PK) has no prod data
  → single-step migration. Down-migration notes live in the migration SQL.
- `implementer` — guards/decorators first, then controllers, then services;
  owner-transfer done inside `$transaction`.
- `tester` — table-driven matrix test wired to the same data file as this
  doc; race-safety test fires 10 concurrent accepts on maxUses=3.
- `reviewer (subagent)` — see `docs/tasks/002-workspace.review.md` for the
  captured review output.
- `release-manager` — branch `feat/task-002-workspace`, multi-commit split
  per spec; PR body staged at `docs/tasks/002-workspace.PR.md`.
