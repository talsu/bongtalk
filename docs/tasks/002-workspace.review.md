# Reviewer subagent — Task 002 Workspace

## Verdict: request-changes

Two **BLOCKER** issues (BLOCKER-1 soft-delete + invite-accept; BLOCKER-2
soft-deleted workspace is still reachable via every `:id` mutating route)
plus several high-value hardening opportunities in the concurrency and
rate-limit paths. The permission matrix and role-rank logic are solid;
static guard coverage is well designed. Fix the two BLOCKERs and the
reviewer recommends approving.

## Findings

### 1. IDOR & route guarding

**PASS (with one caveat).** Every mutating or sensitive read route under
`apps/api/src/workspaces/**/*.controller.ts` that accepts `:id` or
`:wsId` has `WorkspaceMemberGuard` applied (either at class level for
`MembersController` / `WorkspaceInvitesController`, or at method level in
`WorkspacesController`). The static checker at
`scripts/check-guard-coverage.ts:145` codifies this as a test-gate and
refuses to let an unguarded `:id` route ship — nice defensive pattern.

Cross-referenced against `apps/api/test/int/workspaces/permission-matrix.data.ts:37`:
every entry in the matrix maps to a controller method that is guarded
either by class-level `@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)`
or by method-level `@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)`
plus `@Roles(...)`.

`workspaces.controller.ts:46` — `GET /workspaces` (listMine) is
correctly NOT guarded by `WorkspaceMemberGuard` because there is no
`:id`; it filters by `members: { some: { userId } }` at
`workspaces.service.ts:65`. OK.

**nit** — the public `GET /invites/:code` at
`invites.controller.ts:91-95` is intentionally `@Public()`. The code has
16 random bytes (128 bits of entropy via `randomBytes(16).toString('base64url')`
at `invites.service.ts:16-22`) so brute-force enumeration is not viable.
However, there is **no rate limit on `preview`** — see Finding 9.

### 2. Invite concurrency

**PASS on the core CAS, with two correctness nits.**

`invites.service.ts:154-163` — the compare-and-swap

```sql
UPDATE "Invite"
   SET "usedCount" = "usedCount" + 1
 WHERE code = $1
   AND "revokedAt" IS NULL
   AND ("expiresAt" IS NULL OR "expiresAt" > $2)
   AND ("maxUses" IS NULL OR "usedCount" < "maxUses")
```

is atomic at the row level in Postgres (single UPDATE, row-lock during
modification), so N concurrent accepts on `maxUses=K` produce exactly K
successes. This matches the integration-test expectation at
`test/int/workspaces/invites.int.spec.ts:91-121`.

**BLOCKER-1 (race window between CAS and WorkspaceMember.create)** —
`invites.service.ts:169-171`. The same authenticated user firing two
concurrent `POST /invites/:code/accept` requests can:
1. Both calls pass the "already a member?" pre-check at line 142 (no row yet).
2. Both calls succeed in the CAS and decrement `usedCount` by 2.
3. Only one `workspaceMember.create` succeeds; the other throws
   `PrismaClientKnownRequestError P2002` which is NOT caught here. It
   propagates to the `DomainExceptionFilter` as an unclassified error
   → HTTP 500.

Impact: **one invite seat is silently consumed per double-click**, and
the user sees a raw 500 on the second request. For an invite with
`maxUses=3`, three rapid double-clickers from a single user can burn
all seats before any legitimate joiner gets in.

Two independent fixes, pick either:
  a. On `P2002` during `workspaceMember.create`, roll back the CAS by
     `UPDATE "Invite" SET "usedCount" = "usedCount" - 1 WHERE code = $1`
     and return `WORKSPACE_ALREADY_MEMBER`.
  b. Wrap the pre-check + CAS + `workspaceMember.create` in a single
     `$transaction` with `SERIALIZABLE` or use a `SELECT ... FOR UPDATE`
     on the `Invite` row. More expensive but simpler to reason about.

**nit (error-code drift)** — if `revokedAt` or `expiresAt` becomes
non-null between the pre-check at `invites.service.ts:131-140` and the
CAS at lines 154-163, the CAS matches 0 rows and the user gets
`INVITE_EXHAUSTED`. Preferred behavior: check the row returned by a
follow-up `findUnique` and distinguish `revoked` vs `expired` vs
`exhausted` for a cleaner UX.

**PASS (check consistency)** — `preview()` uses
`invite.expiresAt.getTime() <= Date.now()` (inclusive) at
`invites.service.ts:102` and CAS uses `"expiresAt" > $2` (exclusive) at
line 159. Both encode "equal-to-now means expired," consistent.

### 3. Transfer ownership

**PASS on atomicity invariant, with one low-likelihood race.**

`workspaces.service.ts:146-182` correctly wraps the three-step transition
in `$transaction`. All three writes (`from → ADMIN`, `to → OWNER`,
`Workspace.ownerId = toUserId`) commit or roll back together, so there
is never a persisted state with 0 or 2 OWNERs. The integration-test
invariant check at
`test/int/workspaces/workspaces.int.spec.ts:182-186` verifies this.

**suggestion (mild race at default isolation)** — default Prisma
transaction isolation is Postgres `READ COMMITTED`. Two concurrent
transfers from the sole OWNER (e.g. from two browser tabs) both enter
the transaction; `findUnique(target)` at line 154 is a non-locking
read. If the two calls pick different `toUserId`s the last writer
wins. No invariant violation (one OWNER row wins), but the caller's
intent can silently be overridden. Promoting the transaction to
`isolationLevel: 'Serializable'` would make one of the two fail with a
serialization error, which is more correct.

**suggestion (workspace soft-delete guard)** — `transferOwnership` does
not check `workspace.deletedAt`, so ownership of a soft-deleted
workspace can be transferred. Probably harmless, but the grace-period
semantics would be cleaner if transfers were blocked on soft-deleted
workspaces.

### 4. Soft delete invariants

**BLOCKER-2 — `WorkspaceMemberGuard` does not reject soft-deleted
workspaces.**

- `listMine` correctly filters `deletedAt: null` at
  `workspaces.service.ts:65-73`. ✓
- `getWithMyRole` at `workspaces.service.ts:75-86` does NOT filter
  `deletedAt`. A soft-deleted workspace is still returned via
  `GET /workspaces/:id` (the guard lets it through, since
  `workspace-member.guard.ts:43-49` only rejects `!workspace`, not
  `workspace.deletedAt`). Might be intentional to let the OWNER see
  "scheduled for purge at..." → but then `myRole` still surfaces.
- **Mutations on soft-deleted workspaces are not blocked.** After
  `DELETE /workspaces/:id`:
    - `PATCH /workspaces/:id` (rename) still succeeds — the guard
      passes, the service has no `deletedAt` check
      (`workspaces.service.ts:88-97`).
    - `POST /workspaces/:id/invites` — invite creation still succeeds.
      A revoked workspace can still emit invite codes.
    - `POST /invites/:code/accept` on an invite created BEFORE the
      delete — preview blocks it (`invites.service.ts:96`) but `accept`
      does NOT check `workspace.deletedAt` at all. A holder of a valid
      invite code can join a soft-deleted workspace.
    - `PATCH /workspaces/:id/members/:uid/role`, `DELETE /members/:uid`,
      `POST /members/me/leave` — all allowed on soft-deleted workspace.
    - `POST /workspaces/:id/transfer-ownership` — allowed. You can
      transfer ownership of a deleted workspace.
    - Refresh / token operations are in the `auth` module and not
      scoped to a workspace id — not affected.

Fix: add a `deletedAt: null` check to `WorkspaceMemberGuard` (the
workspace is already selected with `deletedAt: true` at line 45, so the
data is available). Opt out explicitly for the handful of routes that
legitimately need to operate on soft-deleted workspaces:
`workspaces.controller.ts:85-92` (`POST /workspaces/:id/restore`) and
possibly `GET /workspaces/:id` for the OWNER. A decorator like
`@AllowSoftDeleted()` keyed via `Reflector` would make the intent
explicit and auditable.

### 5. Raw SQL

**PASS.** `invites.service.ts:154-163` is the only `$executeRawUnsafe`
call in the diff. The SQL string is a **literal** (no user input
interpolated into the string); `code` and `now` are passed as separate
parameters (`$1`, `$2`), which are sent by Prisma via the Postgres
extended-query protocol and are not subject to SQL injection.

**nit (consider `$executeRaw` with a tagged template)** — `Prisma.sql`
+ `$executeRaw` (the safe variant) makes the parameterization visible
at a glance and prevents future contributors from accidentally
concatenating user input. Same semantics, stricter types. Purely
stylistic.

**nit (bind-order sanity)** — `$1` → `code`, `$2` → `now`. Verified OK
at `invites.service.ts:161-162`.

### 6. Role guard coverage

**PASS.** Enumerated every method with a mutation semantic:

- `WorkspacesController` (`workspaces.controller.ts`):
    - `create` (`Post /workspaces`) — no `:id` → correctly no guard.
    - `get` (`Get :id`) — `WorkspaceMemberGuard` only, no `@Roles()` →
      any member. ✓ matches matrix.
    - `update` (`Patch :id`) — `@Roles('ADMIN')`. ✓
    - `softDelete` (`Delete :id`) — `@Roles('OWNER')`. ✓
    - `restore` (`Post :id/restore`) — `@Roles('OWNER')`. ✓
    - `transfer` (`Post :id/transfer-ownership`) — `@Roles('OWNER')`. ✓
- `MembersController` (class-level guard + `@Roles()` per method):
    - `list` — no `@Roles()`, any member. ✓
    - `updateRole` — `@Roles('ADMIN')`. ✓
    - `remove` — `@Roles('ADMIN')`. ✓
    - `leave` — no `@Roles()`, any member. ✓ (self-action; service
      layer rejects OWNER at `members.service.ts:124-128`).
- `WorkspaceInvitesController` (class-level guard + `@Roles()` per
  method): `create`, `list`, `revoke` all `@Roles('ADMIN')`. ✓
- `PublicInvitesController`:
    - `preview` — `@Public()`. ✓
    - `accept` — neither `@Public()` nor a workspace guard (because
      `:code` is not `:id`); `JwtAuthGuard` (the APP_GUARD) enforces
      authentication. ✓

No mutating route is missing a `@Roles()` where it should have one.

**suggestion (defensive default)** — `workspace-role.guard.ts:25`
returns `true` when `@Roles()` is missing. This is the correct
behavior *given* the current controller conventions, but it means a
future developer who forgets to annotate a new sensitive route will
inadvertently expose it to all members. A `@MembersOnly()` marker +
"throw if neither `@MembersOnly()` nor `@Roles()` is present" would be
stricter. Low priority.

### 7. Body parsing

**PASS.** All five `@Body()` sites (`workspaces.controller.ts:37,63,101`
and `invites.controller.ts:45` and `members.controller.ts:48`) use
`safeParse` from the corresponding `@qufox/shared-types` Zod schema
before the validated data is passed into the service. The service
layer receives strongly-typed `CreateWorkspaceRequest`,
`UpdateWorkspaceRequest`, `TransferOwnershipRequest`,
`CreateInviteRequest`, or the narrow `{ role: 'ADMIN' | 'MEMBER' }`.

Spot-checking downstream uses:
- `workspaces.service.ts:38-50` — `create` builds the Prisma `data`
  explicitly from `input.name`, `input.slug`, `input.description ?? null`,
  `input.iconUrl ?? null`, `userId`. No spread of raw body. ✓
- `workspaces.service.ts:88-97` — `update` only pulls
  `name | description | iconUrl` if defined. No spread. ✓
- `workspaces.service.ts:146-182` — `transferOwnership` takes
  `toUserId` as a discrete string. ✓
- `invites.service.ts:32-67` — `create` pulls `expiresAt`, `maxUses`
  only. ✓
- `members.service.ts:29-79` — `updateRole` takes the narrow
  `'ADMIN' | 'MEMBER'` union only. ✓

No object-spread (`...input`) into Prisma `data`, which would be the
common Prisma-unsafe pattern. Good.

### 8. Rank checks (member self-actions)

**PASS.** `members.service.ts:29-79` (`updateRole`) and
`members.service.ts:81-121` (`remove`) enforce the expected matrix:

| Actor | Target | updateRole | remove |
|-------|--------|------------|--------|
| ADMIN | MEMBER | ✓ allowed  | ✓ allowed |
| ADMIN | ADMIN  | ✗ blocked (rank ≤) | ✗ blocked (rank ≤) |
| ADMIN | OWNER  | ✗ blocked (WORKSPACE_CANNOT_DEMOTE_OWNER / WORKSPACE_CANNOT_REMOVE_OWNER) | ✗ blocked |
| OWNER | ADMIN  | ✓ allowed  | ✓ allowed |
| OWNER | MEMBER | ✓ allowed  | ✓ allowed |
| OWNER | OWNER  | (only one) — blocked by `actorId === targetUserId` check at lines 36, 87 | blocked |

The rank condition `ROLE_RANK[actorRole] <= ROLE_RANK[target.role] &&
actorRole !== 'OWNER'` at `members.service.ts:59-61` and 109-111 is
correct: an ADMIN (rank 2) cannot act on another ADMIN (rank 2) or an
OWNER (rank 3); the `actorRole !== 'OWNER'` escape hatch ensures the
OWNER can touch anyone. The separate OWNER-target guard at lines 51-55
and 102-106 is redundant but defence-in-depth — good.

The only note: `updateRole`'s `nextRole` enum is `'ADMIN' | 'MEMBER'`
(enforced both in the Zod schema and in the service signature), so
`OWNER` cannot be assigned by this route. Ownership transfer is forced
through `transferOwnership`. ✓

**suggestion (actor-role staleness)** — the actor's `role` is sourced
from `req.workspaceMember.role`, which is read at guard time. If the
actor is demoted mid-request, the role-check still uses the stale rank.
Consequence: a just-demoted ADMIN could race a single final
`updateRole`/`remove` call. This is standard in role-based systems and
probably not worth fixing.

### 9. Rate limits

**MIXED.** `invites.controller.ts:47-49` rate-limits **invite
creation** at 10/min per workspace. `invites.controller.ts:102-104`
rate-limits **accept** at 30/min per user. Gaps:

- **no rate limit on `preview` (public, unauthenticated)** at
  `invites.controller.ts:91-95`. An attacker can hammer this endpoint
  to:
    - Enumerate invite codes (infeasible at 128 bits, but they can try).
    - Discover workspace names/slugs/icons behind codes (these are
      exposed in the response body).
    - Generate redis/DB load on the service.
  Add a per-IP rate limit (e.g. 60/min) or global rate limit to this
  endpoint.
- **no per-invite-code rate limit on `accept`.** 30/min/user means a
  botnet of N compromised accounts can blast 30·N/min at a single
  `maxUses=3` invite. The CAS is correct so seat consumption is
  bounded, but the N·redis-writes + N·DB reads per minute is a DoS
  surface. Add `key: invite:accept:code:${code}` at e.g. 60/min to
  limit the amplification.
- **no rate limit on workspace creation** (`POST /workspaces`). A
  single user can spin up N workspaces rapidly. Low abuse value (the
  user becomes the OWNER and eats the consequences), but a
  `workspace:create:user:${userId}` limit of ~5/min would be prudent.
- **no rate limit on role-change / member-remove / transfer.** These
  are authenticated and require admin/owner, but a compromised admin
  could flood role changes. Low priority.

### 10. Events

**PASS.** Cross-referenced every state-change event name against the
emission sites:

| Event constant (`events/workspace-events.ts`) | Emitted at |
|---|---|
| `WORKSPACE_CREATED` | `workspaces.service.ts:51` |
| `WORKSPACE_DELETED` | `workspaces.service.ts:106` |
| `WORKSPACE_RESTORED` | `workspaces.service.ts:132` |
| `MEMBER_JOINED` | `invites.service.ts:177` |
| `MEMBER_LEFT` | `members.service.ts:133` |
| `MEMBER_REMOVED` | `members.service.ts:120` |
| `ROLE_CHANGED` | `members.service.ts:71` |
| `OWNERSHIP_TRANSFERRED` | `workspaces.service.ts:175` |
| `INVITE_CREATED` | `invites.service.ts:50` |
| `INVITE_REVOKED` | `invites.service.ts:85` |
| `INVITE_ACCEPTED` | `invites.service.ts:182` |

All 11 event constants are emitted at least once. Payloads appear
consistent with the declared TS types at
`events/workspace-events.ts:13-40` (though the `MemberChangedEvent`
type is declared but never used as a payload shape — cosmetic).

**suggestion (events inside transactions)** — `WORKSPACE_CREATED` is
emitted inside a `prisma.workspace.create` but not inside a
`$transaction`; `OWNERSHIP_TRANSFERRED` is emitted at
`workspaces.service.ts:175` **inside** the `$transaction` callback.
That means if the transaction rolls back (e.g. on the last `update`),
the event was already fired into EventEmitter2's listener fan-out (it's
synchronous; listeners run immediately on `.emit()`). Subscribers that
enqueue work downstream (e.g. a WS broadcast or audit log) will
observe an ownership transfer that never committed.

Move the `.emit()` to after the `$transaction` resolves:
```ts
const result = await this.prisma.$transaction(async (tx) => { /* 3 updates */ return workspace; });
this.emitter.emit(OWNERSHIP_TRANSFERRED, { ... });
return result;
```
Apply the same pattern wherever an event is emitted inside a tx. Same
risk theoretically exists for the `MEMBER_JOINED` + `INVITE_ACCEPTED`
pair — both emitted after a sequence of non-transactional writes at
`invites.service.ts:177-186`, which is fine in isolation but makes the
"consumed a seat but failed to create the member row" case (see
BLOCKER-1) emit `MEMBER_JOINED` / `INVITE_ACCEPTED` semantics via the
retry shape.

## Additional observations

- **Soft-delete purge worker** — `workspaces.service.ts:30` reads
  `WORKSPACE_SOFT_DELETE_GRACE_DAYS` and uses it to set `deleteAt`, but
  there is no purge worker / scheduled job in the diff. `restore` at
  line 122 manually enforces the grace window. Presumably this is
  deferred to a later task; call this out in the follow-up list so we
  don't ship the grace period as a half-implemented feature.
- **`randomUUID()` for workspace id** — `workspaces.service.ts:40` and
  `invites.service.ts:42` both generate UUIDs on the app side despite
  the Prisma schema having `@default(uuid())` on Invite.id at
  `schema.prisma:125`. Consistent but the `Workspace.id` column at
  `schema.prisma:61` has no `@default(uuid())`, so the app-side UUID is
  required. Fine.
- **`WorkspaceMember.workspaceId_userId` composite key lookup** is used
  consistently throughout; the migration at
  `prisma/migrations/20260419092545_add_workspace_invites_members_v2/migration.sql:25-27`
  reshapes the table from an `id` surrogate key to a composite PK,
  matching `schema.prisma:90`.
- **`invite.url` is built in the controller** via
  `invites.controller.ts:27-30` from `process.env.WEB_URL ?? 'http://localhost:45173'`.
  If `WEB_URL` is unset in production, invite links go to localhost.
  Not a security bug but a deploy footgun; add a boot-time assertion
  to `AppModule` or fail fast when `NODE_ENV === 'production'` and
  `WEB_URL` is missing.
- **`RateLimitService.enforce` ordering** — `auth/services/rate-limit.service.ts:27-36`
  increments and *then* checks. Two concurrent calls can both `INCR` to
  `max + 1` and `max + 2` (small overshoot). For tight limits that's a
  real nit, but it's the classic Redis pattern and accepted practice.
- **`CurrentWorkspace` decorator** at `decorators/current-workspace.decorator.ts:11-18`
  is defined but not used in any controller in the diff. Dead code.
  Either wire it up where the `deletedAt` check needs to happen
  in-controller, or remove it.
- **Membership-count invariant** — `delete` on `WorkspaceMember` at
  `members.service.ts:117` can leave a workspace with *zero* members if
  an OWNER somehow is removed (blocked here, but relies on the
  never-demote-OWNER invariant). No code path can drop the last member,
  so the invariant holds in theory. Worth a DB-level check constraint
  or a periodic invariant test.

## Suggested follow-ups

- TODO(task-002-hotfix): **BLOCKER-1** — add rollback-on-P2002 to
  `invites.service.ts::accept` or wrap the CAS + `workspaceMember.create`
  in a single `$transaction`. Add an integration test for the
  double-click-from-same-user scenario (fire two concurrent accepts
  with the same token; assert exactly one 201, one 409
  `WORKSPACE_ALREADY_MEMBER`, `usedCount` incremented by exactly 1).
- TODO(task-002-hotfix): **BLOCKER-2** — make
  `WorkspaceMemberGuard` reject soft-deleted workspaces by default,
  with an `@AllowSoftDeleted()` metadata escape hatch for the
  `restore` route (and possibly `getWithMyRole` for the OWNER). Add
  matrix entries for "PATCH/DELETE/invite-create on soft-deleted
  workspace" → 410 `WORKSPACE_PURGED` or 404 `WORKSPACE_NOT_FOUND`.
  Also block `invites.service.ts::accept` when the workspace is
  soft-deleted (preview already does this).
- TODO(task-NNN): rate-limit `GET /invites/:code` (per IP, e.g.
  60/min) and add per-code rate limit to
  `POST /invites/:code/accept` to bound DoS amplification across
  accounts.
- TODO(task-NNN): move `emit()` calls in
  `workspaces.service.ts::transferOwnership` out of the
  `$transaction` callback so subscribers cannot observe uncommitted
  state changes. Audit all other `.emit()` sites for the same
  pattern.
- TODO(task-NNN): bump
  `transferOwnership`'s `$transaction` to `isolationLevel:
  'Serializable'` so two racing transfers from the sole OWNER cannot
  silently overwrite each other.
- TODO(task-NNN): improve error-code fidelity in `accept` — if the
  CAS returns 0 rows, re-fetch the invite and distinguish
  `INVITE_NOT_FOUND` / `INVITE_EXPIRED` / `INVITE_EXHAUSTED` /
  revoked.
- TODO(task-NNN): boot-time assertion that `WEB_URL` is set in
  production; otherwise invite emails/links go to `localhost:45173`.
- TODO(task-NNN): wire up (or delete) the unused
  `CurrentWorkspace` decorator at
  `apps/api/src/workspaces/decorators/current-workspace.decorator.ts`.
- TODO(task-NNN): schedule the soft-delete purge worker that acts on
  `Workspace.deleteAt <= now()` — otherwise the grace-period UX is
  incomplete.
