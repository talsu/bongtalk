# Reviewer subagent — Task 003 Channels

## Verdict: request-changes

Two **BLOCKER** IDOR vectors in the service layer bypass the guard chain for
routes that do not (or cannot) use `ChannelAccessGuard`, plus a
**BLOCKER**-level inconsistency between the stated "archived = read-only"
contract and the actual guard behaviour on `GET :chid`. Outbox and reorder
paths are mostly sound (at-least-once, SKIP-LOCKED correct; move is
last-write-wins on the same channel) but inter-channel position collisions
aren't covered and a couple of payloads are thin. Merging as-is would ship
a cross-workspace write for OWNERs and surface 409s on legitimately
archived-channel reads.

## Findings

### 1. Guard chain (Member + Role + ChannelAccess)

**BLOCKER — cross-workspace IDOR on `POST /workspaces/:id/channels/:chid/restore`.**
`apps/api/src/channels/channels.controller.ts:105-115` deliberately skips
`ChannelAccessGuard` (a soft-deleted channel can't be loaded by the guard
which blocks `deletedAt`). That is the right instinct, but the service
method does not re-scope:
`apps/api/src/channels/channels.service.ts:206-208` calls
`this.prisma.channel.findUnique({ where: { id: channelId }, ... })` — a
bare `id` lookup with no `workspaceId` filter. An OWNER of workspace A
who learns a soft-deleted channel id belonging to workspace B can call
`POST /workspaces/A/channels/<id-from-B>/restore` and un-delete it.
`WorkspaceMemberGuard` only proves the caller is OWNER of A, not that B's
channel belongs to A. Fix: add `workspaceId` to the where clause (and the
`tx.channel.update` at line 214-217 should prefer `updateMany` scoped by
both `id` and `workspaceId`, then assert rowcount=1).

**BLOCKER — cross-workspace IDOR on `PATCH /workspaces/:id/categories/:catid`
and `POST /workspaces/:id/categories/:catid/move`.**
`apps/api/src/channels/categories/categories.service.ts:82-85` updates by
`{ where: { id: categoryId } }` only.
`apps/api/src/channels/categories/categories.service.ts:153-156` likewise
updates by bare id in the move path. `remove` at line 102-109 pre-checks
with `findFirst({ id, workspaceId })` and is safe; `update` and `move` do
not. An ADMIN/OWNER of workspace A can rename or reposition a category
owned by workspace B just by guessing its id. Fix: mirror
`remove`'s pre-check, or switch to `updateMany({ where: { id, workspaceId }})`
and `expect(count === 1)`.

**BLOCKER — `GET /workspaces/:id/channels/:chid` 409s on archived channels,
contradicting the stated "archived = read-only" contract.**
`apps/api/src/channels/guards/channel-access.guard.ts:69-74` throws
`CHANNEL_ARCHIVED` whenever `archivedAt` is non-null and the route does
not carry `@AllowArchivedChannel()`. The GET handler at
`apps/api/src/channels/channels.controller.ts:58-70` does not opt out, so
an archived channel is invisible to reads — yet it still appears in
`listByWorkspace()` (`apps/api/src/channels/channels.service.ts:57-60`
only filters `deletedAt: null`). So the sidebar shows the row, clicking
it returns 409. The guard's own docstring at
`apps/api/src/channels/guards/channel-access.guard.ts:10-18` claims "an
archived channel is readable"; the implementation does not match. Fix
either (a) annotate `GET :chid` (and conceptually any read route) with
`@AllowArchivedChannel()`, or (b) move the archived check out of the
guard and into each mutating handler. Option (a) is less invasive.

**nit — `archive()` is not idempotent because it inherits the default
archived-block.** `apps/api/src/channels/channels.controller.ts:117-128`
uses `ChannelAccessGuard` without `@AllowArchivedChannel()`. Archiving
an already-archived channel therefore 409s. Task description lists
`archive/unarchive/restore/delete` as the intended opt-outs; `archive`
is the odd one out here. Low impact, but worth an `@AllowArchivedChannel()`
for consistency.

**nit — the param-name normalization is working.** Every `/workspaces/:id/...`
route uses `:id` for the workspace, `:chid` for the channel, `:catid` for
the category (`apps/api/src/channels/channels.controller.ts:33`,
`apps/api/src/channels/categories/categories.controller.ts:30`,
`apps/api/src/channels/categories/categories.controller.ts:51`). The
guard-coverage script was extended to scan the new tree
(`scripts/check-guard-coverage.ts:145-151`). Every `:id`-carrying route
in both controllers has `@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)`
at the class level; every mutating route carries a `@Roles()` annotation.
The guard chain itself is correctly wired.

### 2. Outbox race-safety (record + dispatcher)

**record() — tx propagation is correct.**
`apps/api/src/common/outbox/outbox.service.ts:16-27` writes through the
passed `tx` client when provided, falling back to the PrismaClient
otherwise. Every domain call site in `channels.service.ts`,
`categories.service.ts`, `workspaces.service.ts`, `members.service.ts`,
and `invites.service.ts` passes `tx` inside a `$transaction` callback
(e.g. `apps/api/src/channels/channels.service.ts:124-133`,
`apps/api/src/channels/channels.service.ts:173-178`). The integration
test at `apps/api/test/int/outbox/outbox.int.spec.ts:82-98` forces a
rollback and confirms no row survives, so the contract holds.

**suggestion — the fallback path is a latent footgun.**
`apps/api/src/common/outbox/outbox.service.ts:17` silently allows
`tx = null`. Today no site does this, but a future caller that forgets
to wrap its business write in a `$transaction` would still get a
"successful" outbox write that commits independently of the business
row. The docstring warns, but a `tx` required parameter (or at least
an assertion when `NODE_ENV !== 'production'`) would be safer.

**dispatcher — SKIP LOCKED + RETURNING correctly prevents double-dispatch
between concurrent replicas.**
`apps/api/src/common/outbox/outbox.dispatcher.ts:110-128` claims rows
inside a CTE with `FOR UPDATE SKIP LOCKED` and updates `attempts` with
`RETURNING`. Two concurrent claim queries will see disjoint row sets
because each holds a ROW EXCLUSIVE lock acquired by `FOR UPDATE`. The
test at `apps/api/test/int/outbox/outbox.int.spec.ts:167-188` (20 events,
two concurrent `drain()`s, assert `a + b === 20` and receiver saw 20)
exercises this.

**documented — handler succeeds but `UPDATE ... SET dispatchedAt` fails
produces at-least-once re-emit.** If line 136-139's update errors out
after `emitter.emitAsync(...)` succeeded, the row still has
`dispatchedAt IS NULL` and `attempts` already incremented by the claim
query. The next tick re-claims (the WHERE still matches while
`attempts < maxAttempts`), and the same subscriber receives the event
twice. This is correctly called out in
`apps/api/src/common/outbox/outbox.dispatcher.ts:15-22`: subscribers MUST
dedupe on `row.id`. I'd mark this a product-contract risk: the emitted
payload is the raw `payload` JSON — **`row.id` is NOT part of the
payload**, so subscribers currently have no way to dedupe.

**BLOCKER for at-least-once contract — event consumers cannot dedupe.**
`apps/api/src/common/outbox/outbox.dispatcher.ts:135` calls
`emitter.emitAsync(row.eventType, row.payload)`. The integration test at
`apps/api/test/int/outbox/outbox.int.spec.ts:120-145` shows consumers
receive only the payload, not the row id or any wrapper. The outbox
task description (`docs/tasks/003-channel.md:115-117`) says "subscribers
must dedupe by event.id" — but event.id is not surfaced. Either wrap the
emit in `{ id, type, occurredAt, payload }` or inject the row id into
`payload.eventId`. As-is, the first retry will visibly double-process.

**startup warning — correctly scoped.**
`apps/api/src/common/outbox/outbox.dispatcher.ts:46-57` counts
`{ dispatchedAt: null, attempts: { gt: 0 } }`, which is precisely the
"failed at least once, not yet delivered" set. Zero false positives for
brand-new pending rows.

### 3. Reorder drift / fractional-position saturation

**correct — the reorder race test in the suite exercises the same-channel
case, not the cross-channel collision case.**
`apps/api/test/int/channels/channels.reorder.int.spec.ts:49-60` races two
moves of `channels[2]`. Because both `$transaction`s UPDATE the same
row, only one position persists. The per-row assertion at line 64-70
("every channel in this workspace has a distinct position") always holds
trivially: only one channel moved. What the test does not cover is the
actual collision case.

**suggestion — same-anchor concurrent moves of DIFFERENT channels can
produce duplicate positions.**
`apps/api/src/channels/channels.service.ts:271-341` runs its SELECT for
anchors inside `$transaction` at Postgres's default isolation
(READ COMMITTED). Two concurrent moves of channels X and Y, both asking
to land between the same `beforeId` and `afterId`, can each read the same
`(prev, next)` pair and compute the same midpoint. `calcBetween(a, b)`
is deterministic; there's no uniqueness constraint on
`(workspaceId, categoryId, position)`
(`apps/api/prisma/schema.prisma:146-147` only has a non-unique index).
Result: two channels with identical positions, and the
`orderBy: [{ categoryId }, { position }]` at
`apps/api/src/channels/channels.service.ts:59` yields an indeterminate
tie-break. Low-frequency under typical UI use, but realistic at scale
(drag-drop storms, two admins). Either SERIALIZABLE on the move tx, a
unique index with retry, or an ORDER BY tie-break on `id`/`createdAt`
would harden this. TODO(task-020) already tracks the normalize pass;
worth adding the tie-break there.

**MIN_GAP detection is correct.**
`apps/api/src/channels/positioning/fractional-position.ts:8` sets
`MIN_GAP = 1e-9`. The column is `Decimal(20,10)`
(`apps/api/prisma/schema.prisma:134`), minimum representable difference
`1e-10`, so MIN_GAP has one decimal digit of headroom before the
round-to-scale truncation would start producing ties. The boundary test
at `apps/api/test/unit/channels/fractional-position.spec.ts:40-49`
confirms `gap.lte(MIN_GAP)` throws on the floor.

**nit — the error ambiguates who should normalize.**
`apps/api/src/channels/positioning/fractional-position.ts:37-42` throws
`CHANNEL_POSITION_INVALID` (422) with message "clients should request a
normalize pass". But there is no normalize endpoint yet (TODO task-020),
and this error is an actor-independent server-side saturation — exposing
it as 422 with a "fix your request" tone is misleading to the client.
Consider 409 or 500 until the normalize endpoint exists.

### 4. Param name collision (`:id` vs `:wsId` vs `:chid`)

**correct — `WorkspaceMemberGuard` always resolves the workspace id.**
`apps/api/src/workspaces/guards/workspace-member.guard.ts:44` reads
`req.params.id ?? req.params.wsId`. Every channel/category route uses
`:id` at the workspace segment
(`apps/api/src/channels/channels.controller.ts:33`,
`apps/api/src/channels/categories/categories.controller.ts:30`), so
`req.params.id` is the workspace id and the fallback to `wsId` is
unused. No existing route has both params set to different things.

**BLOCKER-adjacent (already flagged under §1) — `ChannelAccessGuard`'s
fallback to `req.params.id` is correct today but fragile.**
`apps/api/src/channels/guards/channel-access.guard.ts:35` reads
`req.params.chid ?? req.params.id`. On every current route carrying this
guard, `:chid` is present, so the fallback is dead code. If anyone ever
attaches `ChannelAccessGuard` to a route that only has `:id` (the
workspace id), the guard would silently treat the workspace id as a
channel id and consistently 404 — not a security hole (the DB lookup
asserts `workspaceId: wsId`, which would also be the same id), but a
debug nightmare. Recommend removing the fallback and throwing
`VALIDATION_FAILED` when `chid` is absent, or asserting `chid !== wsId`.

### 5. Permission matrix coverage

**incomplete — only 3 of the 14 channel/category endpoints are in the
matrix.** `apps/api/test/int/workspaces/permission-matrix.data.ts:171-207`
adds entries for:
- `GET /workspaces/:id/channels`
- `POST /workspaces/:id/channels`
- `POST /workspaces/:id/categories`

Endpoints NOT in the matrix (defined in the controllers but untested by
the matrix driver):
- `GET /workspaces/:id/channels/:chid` (controller line 58-59)
- `PATCH /workspaces/:id/channels/:chid` (line 72-74)
- `DELETE /workspaces/:id/channels/:chid` (line 90-93)
- `POST /workspaces/:id/channels/:chid/restore` (line 105-106)
- `POST /workspaces/:id/channels/:chid/archive` (line 117-119)
- `POST /workspaces/:id/channels/:chid/unarchive` (line 130-133)
- `POST /workspaces/:id/channels/:chid/move` (line 144-146)
- `PATCH /workspaces/:id/categories/:catid` (categories controller line 50-51)
- `DELETE /workspaces/:id/categories/:catid` (line 67-68)
- `POST /workspaces/:id/categories/:catid/move` (line 79-80)

`docs/tasks/003-channel.md:79-82` handwaves this as "tested in
`channels.int.spec.ts` rather than the matrix data to keep the matrix
concise" — but `channels.int.spec.ts` is a CRUD smoke test, not a full
5×endpoint role-cross, so NON_MEMBER / MEMBER / ADMIN on PATCH/DELETE/
archive/unarchive/move is not actually asserted end-to-end. Given §1
found IDOR bugs in exactly this area, the gap is meaningful. Add at
least the 10 remaining entries.

### 6. move() category handling

**correct for both `undefined` and `null`.**
`apps/api/src/channels/channels.service.ts:280-281`:
`input.categoryId !== undefined ? input.categoryId : current.categoryId`.
- Caller omits the field → `input.categoryId === undefined` → preserve
  `current.categoryId` (could be a uuid or null).
- Caller passes `categoryId: null` → `input.categoryId === null !== undefined`
  → `nextCategoryId = null` (move to uncategorized). Explicit branch.
- Caller passes `categoryId: "<uuid>"` → validated by the `findFirst` at
  line 283-290.

The zod schema allows `null | string | undefined`
(`packages/shared-types/src/channel.ts:33`), matching the service logic.

**nit — the cross-category move via `beforeId`/`afterId` alone can land
the channel in the wrong category.** If the caller passes only
`{ beforeId: someId }` where `someId` lives in category X but the moved
channel is currently in uncategorized, the anchor's `categoryId` is
ignored (`apps/api/src/channels/channels.service.ts:310-311` only uses
the `position`, not the anchor's category). `nextCategoryId` stays as
`current.categoryId`. The computed midpoint is between the anchor's
position and null/another-category's position, so the resulting channel
can land with a position that makes no sense relative to its siblings.
Not a correctness bug (FE compensates), but the API contract should
either (a) infer `nextCategoryId` from the anchor when `categoryId` is
undefined, or (b) reject `beforeId`/`afterId` when they cross categories
without an explicit `categoryId`.

### 7. Event payload completeness

**suggestion — the thin payloads (`channel.deleted`, `channel.archived`,
`channel.unarchived`, `channel.restored`) carry only
`{ workspaceId, actorId, channelId }`.**
`apps/api/src/channels/channels.service.ts:199`,
`apps/api/src/channels/channels.service.ts:222`,
`apps/api/src/channels/channels.service.ts:238`,
`apps/api/src/channels/channels.service.ts:254`. Contrast with
`channel.created` / `channel.updated` / `channel.moved` which include
the full DTO (line 131, 177, 337). A realtime subscriber that starts
listening mid-session has no baseline channel state to delete-by-id
from, so receiving `{ channelId }` is fine — but receiving
`{ channelId, name, archivedAt }` would let the UI show "Channel
#foo was archived by @alice just now" without a refetch. Shape each
payload with the same `channel: this.toDto(channel)` envelope used by
`channel.updated`.

**note — `category.updated` also drops most of the category.**
`apps/api/src/channels/categories/categories.service.ts:90` emits only
`{ workspaceId, actorId, categoryId }`. `category.created`,
`category.deleted`, `category.moved` at lines 50-59, 110-115, 157-170
do the right thing (full or sufficient payload). Align `category.updated`.

### 8. Misc

**seed is still deterministic across resets.**
`apps/api/prisma/seed.ts:81,91` hard-codes positions
`1000000000.0000000000` and `2000000000.0000000000` — these are valid
`Decimal(20,10)` values with STRIDE spacing (`POSITION_STRIDE = 1e9`
from `apps/api/src/channels/positioning/fractional-position.ts:11`),
exactly what `calcBetween(null, null)` would produce for the first
channel and `calcBetween(firstPos, null)` for the second. Because
`upsert` with `update: {}` is a no-op when the row exists, re-running
seed never writes the `position` column after the first run, so any
mid-session `move()` is preserved across reseeds. Deterministic at
migration-reset and additive-only on top.

**`dispatcher.pausePolling()` is a test-only hook but production code
could accidentally call it.**
`apps/api/src/common/outbox/outbox.dispatcher.ts:76-80` is `public`
without even a `@internal` TSDoc tag or a naming convention hint.
`OutboxModule` is `@Global`
(`apps/api/src/common/outbox/outbox.module.ts:5-10`), so any provider
in the app can `@Inject(OutboxDispatcher)` and call `pausePolling()`.
Two easy fixes: prefix with `_` / rename to `__internalPausePolling`,
or emit a `logger.warn` in non-`test` `NODE_ENV`.

**`current-channel.decorator.ts` is entirely unused.**
`apps/api/src/channels/decorators/current-channel.decorator.ts:13-20`
defines `@CurrentChannel()` but no controller or service consumes it
(grep confirms zero importers). Dead code — delete, or put it to use
in the `get`/`update`/`archive`/`unarchive`/`move` handlers that
could read `req.channel` instead of re-fetching via
`listByWorkspace()`.

**`GET /workspaces/:id/channels/:chid` handler is O(N) in workspace
channels.** `apps/api/src/channels/channels.controller.ts:65-69` calls
`listByWorkspace()` and flattens then searches. With `ChannelAccessGuard`
having already fetched the channel row onto `req.channel`, the handler
should just `return req.channel` (or re-fetch by id with workspace
scope). Current implementation wastes a round-trip that scales with
the workspace size.

**`start()` races with `stopping`.**
`apps/api/src/common/outbox/outbox.dispatcher.ts:69-74` guards with
`if (this.timer || this.stopping) return;` — good — but `onModuleInit`
runs `start()` unconditionally. During graceful shutdown, if
`onModuleDestroy` sets `stopping = true` between a tick firing and
`currentTick` resolving, we're safe. But if `start()` is later called
externally after `stopping` was flipped, the dispatcher would silently
refuse. Not a bug today, but the asymmetry (no `resumePolling()` that
resets `stopping`) is worth noting if task-020 introduces hot-reload.

## Suggested follow-ups

- **TODO(task-003-blocker-1)**: scope `channels.restore` to `{ id, workspaceId }`
  to close the cross-workspace IDOR in
  `apps/api/src/channels/channels.service.ts:206-217`.
- **TODO(task-003-blocker-2)**: scope `categories.update` and `categories.move`
  to `{ id, workspaceId }` (or add a `findFirst` pre-check mirroring `remove`)
  to close the cross-workspace IDOR in
  `apps/api/src/channels/categories/categories.service.ts:82-85` and 153-156.
- **TODO(task-003-blocker-3)**: align `GET /workspaces/:id/channels/:chid`
  with the "archived = read-only" contract. Either annotate the GET handler
  with `@AllowArchivedChannel()` or refactor the archive check out of the
  guard and into each mutating handler. Also reconsider `archive` idempotency.
- **TODO(task-003-blocker-4)**: surface the outbox row id (or `eventId`) in
  the emitted payload so subscribers can actually honour the documented
  at-least-once dedupe contract.
- **TODO(task-003-followup-1)**: extend `permission-matrix.data.ts` with the
  10 remaining channel/category endpoints — especially the
  archive/unarchive/move/restore paths — so the 5-role cross is enforced
  by the table test rather than by hand-written specs.
- **TODO(task-020-reorder-tiebreak)**: add either a `(workspaceId, categoryId,
  position)` unique index (with retry-on-conflict) OR a
  secondary ORDER BY `id` tiebreak to `listByWorkspace` and the move anchor
  query, to eliminate indeterminate ordering when two concurrent moves land
  on the same midpoint.
- **TODO(task-003-followup-2)**: thicken `channel.deleted` /
  `channel.archived` / `channel.unarchived` / `channel.restored` /
  `category.updated` payloads with the DTO (or at minimum `name` and
  `archivedAt`/`deletedAt`).
- **TODO(task-003-followup-3)**: delete `current-channel.decorator.ts` or
  wire the GET handler to use `req.channel` instead of re-listing the
  workspace.
- **TODO(task-003-followup-4)**: make `OutboxService.record()`'s `tx`
  parameter required (or assert on `null` in non-prod) to remove the
  "forgot to wrap in `$transaction`" footgun at
  `apps/api/src/common/outbox/outbox.service.ts:16-17`.
- **TODO(task-003-followup-5)**: rename or flag
  `OutboxDispatcher.pausePolling()` as test-only (e.g. `_pausePollingForTests`)
  since it lives on a `@Global` provider that any domain module can inject.
