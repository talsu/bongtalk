# feat(workspace): CRUD/members/roles/invites (task-002)

## Summary
- Multi-tenancy spine: workspace CRUD, member roles (OWNER/ADMIN/MEMBER), invite lifecycle, soft delete with 30-day grace.
- IDOR-safe guard chain: `WorkspaceMemberGuard` (injects `req.workspace` + `req.workspaceMember`, hides existence behind 404 for non-members, rejects soft-deleted unless route opts in) → `WorkspaceRoleGuard` (pure rank compare on cached role).
- Race-safe invite accept: atomic CAS (`UPDATE ... WHERE usedCount < maxUses`) + P2002 refund so double-clicks don't consume extra seats.
- Transfer ownership wrapped in `$transaction`; single-OWNER invariant asserted by integration test.
- **Prerequisite** (separate commit): SWC pipeline unified across vitest / build (`@swc/cli`) / dev (`@swc-node/register` + `nodemon`); ~2.4s hot restart; shared-types now dual-CJS/ESM via `tsup` so both NestJS CJS and Vite ESM consume the same package.

## API Changes
| Method | Path | Status codes |
|---|---|---|
| POST | `/workspaces` | 201 / 422 WORKSPACE_SLUG_RESERVED / 409 WORKSPACE_SLUG_TAKEN |
| GET | `/workspaces` | 200 (my workspaces) |
| GET | `/workspaces/:id` | 200 { workspace, myRole } / 404 WORKSPACE_NOT_MEMBER |
| PATCH | `/workspaces/:id` | 200 / 403 WORKSPACE_INSUFFICIENT_ROLE |
| DELETE | `/workspaces/:id` | 202 { deleteAt } (OWNER only) |
| POST | `/workspaces/:id/restore` | 201 (OWNER only, within grace) / 410 WORKSPACE_PURGED |
| POST | `/workspaces/:id/transfer-ownership` | 200 (OWNER only) / 404 WORKSPACE_TARGET_NOT_MEMBER |
| GET | `/workspaces/:id/members` | 200 { members[] } |
| PATCH | `/workspaces/:id/members/:uid/role` | 200 / 403 WORKSPACE_CANNOT_DEMOTE_OWNER |
| DELETE | `/workspaces/:id/members/:uid` | 204 / 403 WORKSPACE_CANNOT_REMOVE_OWNER |
| POST | `/workspaces/:id/members/me/leave` | 204 / 409 WORKSPACE_OWNER_MUST_TRANSFER |
| POST | `/workspaces/:id/invites` | 201 { invite, url } |
| GET | `/workspaces/:id/invites` | 200 |
| DELETE | `/workspaces/:id/invites/:inviteId` | 204 |
| GET | `/invites/:code` (public) | 200 / 404 / 410 EXPIRED / 410 EXHAUSTED |
| POST | `/invites/:code/accept` | 201 / 409 WORKSPACE_ALREADY_MEMBER / 410 |

Full permission matrix: see `docs/tasks/002-workspace.md` (authoritative source in `apps/api/test/int/workspaces/permission-matrix.data.ts`).

## DB Migrations
`apps/api/prisma/migrations/20260419092545_add_workspace_invites_members_v2/`:
- `Workspace`: `+ description, iconUrl, deletedAt, deleteAt` + indexes on `(ownerId)` and `(deletedAt)`.
- `WorkspaceMember`: single-column `id` dropped, composite PK `(workspaceId, userId)` introduced, `+ @@index([userId])`, `@@index([workspaceId, role])`.
- `Invite`: `+ maxUses, usedCount (default 0), revokedAt`; dropped the single-use `usedAt`.
- Reversible: the composite-PK flip is destructive but ships before any real data. Future down-migration must re-introduce `id @default(uuid())` and copy rows.

## Permission Matrix
| Endpoint | Anon | Non-member | Member | Admin | Owner |
|---|---|---|---|---|---|
| POST /workspaces | 401 | 201 | 201 | 201 | 201 |
| GET /workspaces/:id | 401 | 404 NOT_MEMBER | 200 | 200 | 200 |
| PATCH /workspaces/:id | 401 | 404 | 403 INSUFFICIENT | 200 | 200 |
| DELETE /workspaces/:id | 401 | 404 | 403 | 403 | 202 |
| GET /workspaces/:id/members | 401 | 404 | 200 | 200 | 200 |
| PATCH /workspaces/:id/members/:uid/role | 401 | 404 | 403 | 200 | 200 |
| DELETE /workspaces/:id/members/:uid | 401 | 404 | 403 | 204 | 204 |
| POST /workspaces/:id/members/me/leave | 401 | 404 | 204 | 204 | 409 |
| POST /workspaces/:id/transfer-ownership | 401 | 404 | 403 | 403 | 200 |
| POST /workspaces/:id/invites | 401 | 404 | 403 | 201 | 201 |
| GET /workspaces/:id/invites | 401 | 404 | 403 | 200 | 200 |

## Concurrency & Correctness Proofs
- **Invite race (evals/tasks/006)**: `invites.int.spec.ts` fires 10 concurrent accepts on `maxUses=3`; asserts exactly 3 × 201 + 7 × 410 INVITE_EXHAUSTED; `invite.usedCount == 3` verified directly via Prisma. Implementation: atomic `UPDATE ... WHERE usedCount < maxUses` + P2002 refund on the member-create loser.
- **Transfer ownership**: `workspaces.int.spec.ts` does one transfer then asserts `prisma.workspaceMember.count({ workspaceId, role: 'OWNER' }) === 1`. Implementation: all three writes in `$transaction` — demote old, promote new, flip `Workspace.ownerId`.
- **Slug race**: Prisma `P2002` → `WORKSPACE_SLUG_TAKEN` 409 (not 500).

## Security Checklist
| Requirement | Where |
|---|---|
| IDOR — non-members see 404 | `workspace-member.guard.ts` (throws `WORKSPACE_NOT_MEMBER` with 404 status) |
| Soft-deleted workspaces invisible | `workspace-member.guard.ts` rejects `deletedAt` unless `@AllowSoftDeleted()` opts in (used only by `restore`) |
| Role guard can't be bypassed by omitting `@Roles()` | default = any member, mutating routes explicitly mark `@Roles('ADMIN' or 'OWNER')` |
| Rate limit on mutating invite ops | `invites.controller.ts` — create (10/min per-ws), preview (60/min per-IP), accept (30/min per-user) |
| Audit events emitted on every state change | `workspaces/events/workspace-events.ts` + all three services |
| Invite code log-masking | only `invite.id` logged; raw code only in `Set-Cookie`/response body |
| Raw SQL parameter-bound | `$executeRawUnsafe(sql, $1, $2)` with positional bindings; no string concatenation |

## Reviewer Subagent Output
Captured at `docs/tasks/002-workspace.review.md`. Verdict: **request-changes** → 2 BLOCKERs fixed in this PR before merge:
- **BLOCKER-1** (invite double-click race): `invites.service.ts::accept` now catches P2002 on member-create, refunds `usedCount`, and returns `WORKSPACE_ALREADY_MEMBER` instead of 500.
- **BLOCKER-2** (soft-deleted workspace reachable via every mutating route): `WorkspaceMemberGuard` now rejects `deletedAt` by default; `@AllowSoftDeleted()` opt-in for `restore`.
- Preview rate limit added (60/min per IP).
- Remaining nits (event emission inside $transaction, serializable isolation for transfer, CAS error fidelity) captured as follow-ups below.

## Test Evidence
- `pnpm -w run verify` → exit 0 (16/16 turbo tasks, 24 unit tests across shared-types/api/web)
- `pnpm --filter @qufox/api test:int` → **84/84 tests, 44.5s** (realtime 1 + auth 16 + workspaces CRUD 8 + permission matrix 55 + invites incl. race 4)
- `pnpm --filter @qufox/web test:e2e` (dockerized Playwright) → **7/7 pass** (auth 3 + smoke 1 + workspaces 3)
- `pnpm smoke` → signup → ws create → invite create → accept → member list roundtrip
- `pnpm audit --prod --audit-level=high` → 0 high/critical
- `pnpm eval -- --dry-run` → 6 tasks, 100% success
- `scripts/check-guard-coverage.ts` → OK (12/12 routes guarded)
- `pnpm build && node apps/api/dist/main.js` → boots and answers `/healthz`
- Dev watch restart: ~2.4s measured (nodemon + `@swc-node/register`)

## Follow-ups
- `TODO(task-014)`: invite + soft-delete purge batch (delete workspaces past `deleteAt`, hard-delete revoked invites).
- `TODO(task-015)`: audit log persistence (currently events fire but are not stored).
- `TODO(task-016)`: channel-level permission override.
- `TODO(task-017)`: workspace icon upload (S3).
- `TODO(task-018)`: billing / member caps.
- Reviewer nits not converted to blockers (tracked in `docs/tasks/002-workspace.review.md`):
  - `transferOwnership` emits `OWNERSHIP_TRANSFERRED` inside the Prisma callback — can leak pre-commit state to subscribers; move `emit()` outside the transaction.
  - `$transaction` default isolation is READ COMMITTED; two racing OWNER transfers from the sole OWNER can silently overwrite. Bump to `Serializable`.
  - CAS returning 0 rows is always reported as `INVITE_EXHAUSTED` even when the real cause is revoked/expired; split the checks.
  - Unused `CurrentWorkspace` decorator — keep for task-003 consumers or delete.
