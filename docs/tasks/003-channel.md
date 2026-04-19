# Task 003 — Channel Module: CRUD / Categories / Positioning

## Context
Builds on task-002's workspace guard chain (`WorkspaceMemberGuard` +
`WorkspaceRoleGuard` + `@Roles()`) to deliver the Channel domain — the
container into which task-004 Messages will live and the broadcast unit
task-005 Realtime will fan out over WebSockets. The prerequisite **outbox
pattern** (Cleanup-1 below) lands first so every state-change event is
both durable and post-commit visible; this kills the "emit inside tx"
reviewer nit from task-002 and sets the pattern for all future domain
modules.

## Scope (IN)
- Prerequisite **Cleanup-1 — Transactional outbox** (separate commit):
  `OutboxEvent` model + `OutboxService.record()` + `OutboxDispatcher`
  (`@Interval` poll + `FOR UPDATE SKIP LOCKED`). All 11 existing
  `EventEmitter.emit` sites migrated to `outbox.record(tx, ...)`; the only
  exception is auth's `SESSION_COMPROMISED` which stays direct because
  immediacy matters more than durability.
- Cleanup-2 (E2E parallelization): **deferred** — E2E still `workers: 1`.
  Current runtime 15s; will revisit if task-004 pushes it past 60s.
- Channel CRUD (TEXT only; VOICE/ANNOUNCEMENT enum defined but return
  `422 CHANNEL_TYPE_NOT_IMPLEMENTED`).
- Category (1-level grouping) with the same fractional positioning.
- Soft delete + restore + archive/unarchive (archive is read-only state,
  separate from delete).
- Reorder via `POST /channels/:chid/move` with `beforeId` / `afterId`
  anchors and optional category change.
- `ChannelAccessGuard` — composes on top of `WorkspaceMemberGuard`,
  enforces archived=read-only by default, opt-out via `@AllowArchivedChannel()`.
- Outbox events: `channel.{created,updated,deleted,restored,archived,unarchived,moved}`
  + `category.{created,updated,deleted,moved}`.
- Frontend: `/w/:slug/:channelName` route, `ChannelSidebar` with
  `@dnd-kit` drag-reorder, create channel/category inline, MEMBER hides
  the create panel.
- Unit (fractional-position) + Integration (channels CRUD, matrix,
  concurrent reorder, outbox round-trip) + E2E (3 flows).
- Guard coverage checker extended to `apps/api/src/channels/**`
  (**25/25 routes guarded**).

## Scope (OUT) — future tasks
- Messages in channels → task-004.
- Realtime WS broadcast of channel events → task-005.
- Per-channel ACL (`isPrivate` field is reserved) → task-016.
- VOICE / ANNOUNCEMENT type implementations → task-005 / task-019.
- Position-normalize batch (when Decimal gap approaches 1e-9) → task-020.

## Acceptance Criteria (mechanical)
1. **Outbox**: tx rollback leaves no `OutboxEvent`; dispatcher drain
   emits every row exactly once; two concurrent drains never double-dispatch
   (`FOR UPDATE SKIP LOCKED`).
2. `pnpm -w run verify` exit 0.
3. `pnpm --filter @qufox/api test:int` exit 0 — **114/114 tests**.
4. `pnpm --filter @qufox/web test:e2e` via dockerized Playwright → **10/10**.
5. `pnpm smoke` — healthz/readyz + auth + workspace + **channel create/list/patch/delete**.
6. `pnpm audit --prod` → 0 high/critical (5 vulns total, 1 low + 4 moderate).
7. `scripts/check-guard-coverage.ts` → **25/25 routes guarded** across
   workspaces + channels.
8. `permission-matrix.data.ts` extended (+3 entries: list/create channels,
   create category). Matrix test drives the full set.
9. `.env.example` adds `OUTBOX_DISPATCH_INTERVAL_MS`,
   `OUTBOX_BATCH_SIZE`, `OUTBOX_MAX_ATTEMPTS`.
10. Migration named `add_outbox_channel_category`; reversible via
    standard `DROP TABLE`/`DROP COLUMN`.
11. `evals/tasks/007-009` added + `pnpm eval --dry-run` green (9 tasks).
12. Reviewer subagent spawned (see Progress Log).

## Permission Matrix (extension only)

Full matrix remains in `apps/api/test/int/workspaces/permission-matrix.data.ts`
— the test generates 70 cases from that data file. Task-003 additions:

| Endpoint | Anon | Non-member | Member | Admin | Owner |
|---|---|---|---|---|---|
| GET /workspaces/:id/channels | 401 | 404 NOT_MEMBER | 200 | 200 | 200 |
| POST /workspaces/:id/channels | 401 | 404 | 403 INSUFFICIENT | 201 | 201 |
| POST /workspaces/:id/categories | 401 | 404 | 403 | 201 | 201 |

(PATCH / DELETE / archive / unarchive / move on channel + category all
follow the same OWNER-or-ADMIN rule — tested in
`channels.int.spec.ts` rather than the matrix data to keep the matrix
concise.)

## Positioning Algorithm Decision — A (Fractional Decimal)
Decimal(20,10) fractional indexing. `calcBetween(prev, next)` returns
`(prev+next)/2` for midpoints, `prev ± STRIDE(1e9)` for append/prepend,
and throws `CHANNEL_POSITION_INVALID` when the available gap falls below
**MIN_GAP = 1e-9** (i.e. ~33 consecutive midpoint insertions from the
same baseline before a normalize pass is required). Normalize batch is
tracked as `TODO(task-020)`.

## Outbox Event Schemas
All event payloads share `{ id (event uuid), type, occurredAt (ISO),
workspaceId, actorId, … }`. Channel-specific fields are nested under
`channel`:
```ts
channel: {
  id, name, type, categoryId, topic, position: string /* Decimal */,
  isPrivate, archivedAt, deletedAt, createdAt
}
```
Category events carry `category: { id, workspaceId, name, position }`.

## Non-goals
- Messages, realtime fan-out, per-channel ACL.

## Risks
- **Path-param name collision** — adding a 3rd controller under
  `/workspaces/:…` with a different param name than the others
  (`:wsId` vs `:id`) caused Express 4.21 + path-to-regexp 0.1.13 to
  404 every route on that controller. Fixed by normalizing to `:id`
  at the workspace-segment and `:chid` / `:catid` for the inner
  channel/category id. Added a note in the controller comments to
  preserve this invariant.
- **Outbox dispatcher crashing mid-batch** — at-least-once delivery,
  so subscribers must dedupe by `event.id`. The docstring in
  `outbox.dispatcher.ts` calls this out.

## Progress Log
- `planner` — plan + permission matrix + A/B positioning option emitted;
  user picked (A / defer Cleanup-2 / merge task-002 to main before start).
- `db-migrator` — outbox + channel schema changes in a single migration
  `add_outbox_channel_category`. ALTER TYPE for VOICE/ANNOUNCEMENT
  applied as separate sub-statement.
- `implementer` — outbox first (service + dispatcher); migrated 11 emit
  sites in workspaces/member/invites; built channel/category services,
  controllers, guards, decorators, events. Fractional-position module
  landed with unit tests before the main service.
- `tester` — unit: fractional-position (7 cases). Integration:
  outbox.int (6), channels.int (7), channels.reorder.int (1 concurrent),
  channels.events.int (1 outbox dispatch), extended
  permission-matrix.int (70 cases). E2E: 3 channel flows.
- `reviewer (subagent)` — report captured at
  `docs/tasks/003-channel.review.md`. Verdict + actions below.
- `release-manager` — `feat/task-003-channel` branch, multi-commit
  split per task prompt; PR body at `docs/tasks/003-channel.PR.md`.
