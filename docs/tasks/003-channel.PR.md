# feat(channel): CRUD/categories/reordering + transactional outbox (task-003)

## Summary
- **Prerequisite (separate commit)**: transactional outbox so every domain event
  (workspace/member/invite/channel/category — 11 emit sites migrated) is durable
  + post-commit visible. Fixes the task-002 "emit inside $transaction" nit.
- Channel CRUD (TEXT only; VOICE/ANNOUNCEMENT enum reserved, return 422) +
  categories + soft delete/restore/archive/unarchive + fractional-position
  drag reorder.
- Frontend: `@dnd-kit` sidebar under `WorkspaceLayout`, inline create panels
  gated on `canManage`, `/w/:slug/:channelName` route.
- 114/114 integration tests · 10/10 E2E · 9/9 eval dry-run · 25/25 guard-
  coverage routes.
- Reviewer subagent spawned — 4 BLOCKERs fixed in this PR before merge (see
  `docs/tasks/003-channel.review.md`).

## API Changes
| Method | Path | Status codes |
|---|---|---|
| GET | `/workspaces/:id/channels` | 200 { categories[], uncategorized[] } |
| POST | `/workspaces/:id/channels` | 201 / 422 CHANNEL_NAME_INVALID / 422 CHANNEL_TYPE_NOT_IMPLEMENTED / 409 CHANNEL_NAME_TAKEN |
| GET | `/workspaces/:id/channels/:chid` | 200 (archived channels readable) / 404 CHANNEL_NOT_FOUND |
| PATCH | `/workspaces/:id/channels/:chid` | 200 / 409 CHANNEL_ARCHIVED |
| DELETE | `/workspaces/:id/channels/:chid` | 202 (OWNER only) |
| POST | `/workspaces/:id/channels/:chid/restore` | 201 (OWNER) / 404 / 410 CHANNEL_PURGED |
| POST | `/workspaces/:id/channels/:chid/archive` | 201 (ADMIN) |
| POST | `/workspaces/:id/channels/:chid/unarchive` | 201 (ADMIN) |
| POST | `/workspaces/:id/channels/:chid/move` | 201 / 422 CHANNEL_POSITION_INVALID |
| POST | `/workspaces/:id/categories` | 201 (ADMIN) / 409 CATEGORY_NAME_TAKEN |
| PATCH | `/workspaces/:id/categories/:catid` | 200 / 404 CATEGORY_NOT_FOUND |
| DELETE | `/workspaces/:id/categories/:catid` | 204 (channels stay, categoryId=null) |
| POST | `/workspaces/:id/categories/:catid/move` | 201 |

Full matrix: `apps/api/test/int/workspaces/permission-matrix.data.ts`.

## DB Migrations
1. `20260419103534_add_outbox_channel_category` — OutboxEvent table; ChannelType
   enum extended (ALTER TYPE ... ADD VALUE 'VOICE' / 'ANNOUNCEMENT').
2. `20260419104550_add_channel_category_positioning` — Category model; Channel
   gains categoryId/topic/position/isPrivate/archivedAt/deletedAt + indexes.

Reversible via standard DROP TABLE / DROP COLUMN.

## Outbox Contract
- `OutboxService.record(tx, { aggregateType, aggregateId, eventType, payload })`
  — pass the Prisma tx client so the row commits with the business write.
- `OutboxDispatcher` polls every `OUTBOX_DISPATCH_INTERVAL_MS` (default 250ms).
  `FOR UPDATE SKIP LOCKED` prevents double-dispatch across replicas.
- **At-least-once**: emitted envelope includes `event.id`. Subscribers must
  dedupe by that id.
- `OUTBOX_BATCH_SIZE` (default 50), `OUTBOX_MAX_ATTEMPTS` (default 10,
  DLQ = `attempts >= max`).

## Concurrency & Correctness Proofs
- **Outbox (eval 009)** — `outbox.int.spec.ts` 6 cases: rollback leaves no row;
  commit persists; dispatcher drain emits exactly once per event; two concurrent
  drains never double-dispatch (SKIP LOCKED); retry marks lastError and
  succeeds on a later tick.
- **Channel reorder race (eval 008)** — two admins reorder the same channel
  concurrently; both 201 and every final position distinct.
- **Invite race (carried from task-002)** — 10 concurrent accepts on maxUses=3
  → exactly 3 succeed, 7 INVITE_EXHAUSTED.

## Security Checklist
| Requirement | Location |
|---|---|
| Guard coverage 25/25 | `scripts/check-guard-coverage.ts` |
| Cross-workspace IDOR: channels.restore | `channels.service.ts` (findFirst scoped) |
| Cross-workspace IDOR: categories.update/move | `categories.service.ts` (updateMany / findFirst scoped) |
| Archived read-only by default | `ChannelAccessGuard` + `@AllowArchivedChannel` |
| Event payloads include event id | `outbox.dispatcher.ts` envelope |
| Role rank DB check in guard | `WorkspaceRoleGuard` uses cached `req.workspaceMember` |
| ChannelType not-implemented trap | `channels.service.ts::assertTypeImplemented` |
| Reserved channel names blocked | `CHANNEL_RESERVED_NAMES` (`everyone`/`here`) |
| Fractional-position saturation detected | `calcBetween` throws CHANNEL_POSITION_INVALID when gap ≤ 1e-9 |

## Reviewer Subagent Output
Full report at `docs/tasks/003-channel.review.md`. **Verdict: request-changes** →
4 BLOCKERs fixed before commit:
1. Cross-workspace IDOR on `POST /workspaces/:id/channels/:chid/restore` — now
   scoped by `{ id, workspaceId }`.
2. Cross-workspace IDOR on `PATCH/POST /categories/:catid` (update + move) —
   `updateMany` / `findFirst` with `workspaceId` scope.
3. `GET /workspaces/:id/channels/:chid` 409'd on archived rows even though the
   list returned them — GET handler now opts out with
   `@AllowArchivedChannel()` and returns `req.channel` directly.
4. Outbox at-least-once unfulfillable because `event.id` wasn't emitted — the
   dispatcher now emits a full envelope with `id` + metadata.

Non-blocker follow-ups captured in the review doc (different-channel reorder
race, 5-role matrix coverage of all 14 endpoints, thin delete/archive event
payloads).

## Test Evidence
```
pnpm -w run verify           → 16/16 turbo (40 unit+contract tests)
pnpm --filter @qufox/api test:int → 9 files, 114/114 tests, 76.8s
pnpm --filter @qufox/web test:e2e  → 10/10 pass (dockerised Playwright)
pnpm smoke                    → auth + ws + invite + channel CRUD all green
pnpm audit --prod --audit-level=high → 0 high/critical
scripts/check-guard-coverage.ts      → 25/25 :id routes guarded
pnpm eval -- --dry-run         → 9 tasks, 100% success
```

## Follow-ups
- `TODO(task-020)`: position-normalize batch when Decimal gap approaches 1e-9
  on heavy reorder traffic.
- `TODO(task-015)`: persist outbox envelopes to a real audit log table.
- `TODO(task-016)`: per-channel ACL (`isPrivate` field is reserved today).
- `TODO(task-005)`: WS adapter subscribes to outbox events for workspace-
  scoped fanout; VOICE channel implementation.
- `TODO(task-019)`: ANNOUNCEMENT channel (broadcast-only).
- Reviewer nits carried forward in `docs/tasks/003-channel.review.md`
  (unused `CurrentChannel` decorator, thin payloads, matrix scope).
