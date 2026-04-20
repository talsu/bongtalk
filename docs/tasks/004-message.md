# Task 004 — Message Module: CRUD / Cursor Pagination / Idempotent Send

## Context

Messages are the primary UX of the platform. This task delivers the
persistence + read path that task-005 Realtime will fan out over WebSockets,
so the data model, pagination shape, and idempotency semantics are locked in
here — task-005 can be a pure projection layer.

Builds on task-003's outbox pattern (`message.{created,updated,deleted}`
envelopes), guard chain (`WorkspaceMemberGuard → ChannelAccessGuard`), and
permission-matrix data file (extended with 8 message entries).

## Scope (IN)

- Text-only CRUD on `Message` with 1-4000 char content, soft-delete, and
  audit-preserving content masking in responses.
- **Cursor-based pagination** — opaque `base64url(JSON({t,id}))` DTO ⇢
  PostgreSQL row-value comparison `(created_at, id) < ($1,$2)` under the hood.
  Bi-directional (`before`, `after`) plus `around=<msgId>`.
- **Idempotent send** — optional `Idempotency-Key: <uuid>` header dedupes
  retries against a PARTIAL unique index; conflicting content with the same
  key returns 409.
- **Mention extraction** — `@username`, `#channel`, `@everyone` parsed
  server-side, scoped to the workspace; client-supplied `mentions` is never
  trusted.
- **Rate limiting** — user 30/10s + channel 60/10s on POST, user 600/min on
  GET; 429 `RATE_LIMITED` on breach.
- `MessageAuthorGuard` (PATCH) + service-layer author-or-ADMIN check (DELETE).
- Frontend: `MessagePanel` with infinite-scroll history, optimistic send with
  `Idempotency-Replayed` reconciliation, inline edit/delete.

## Scope (OUT) — future tasks

- Realtime WS fan-out of `message.*` events → **task-005**.
- Attachments (S3) → TODO(task-017).
- Reactions → TODO(task-023).
- Threads / replies → TODO(task-024).
- Full-text search → TODO(task-025).
- Mention notifications (the parsed mentions land in the DB today) → TODO(task-021).
- Edit-time window / permanent purge of soft-deleted rows → TODO(task-022).

## Acceptance Criteria (mechanical)

1. `pnpm verify` exit 0.
2. `pnpm --filter @qufox/api test:int` exit 0 — including
   `messages.int`, `messages.pagination`, `messages.idempotency`,
   `messages.events`, `messages.rate-limit`, `messages.explain`, and the
   extended `permissions.matrix` (+8 cases).
3. `pnpm --filter @qufox/web test:e2e` via dockerized Playwright — messages
   send-and-receive + edit-delete on top of existing channel flows.
4. `pnpm smoke` exercise send → list → edit → delete.
5. `scripts/check-guard-coverage.ts` → **30/30 routes guarded**.
6. Migration `add_message_pagination_idempotency` reversible (DROP INDEX /
   DROP COLUMN); backfills `contentPlain` from `content` for the five
   phase-0 seed rows.
7. **EXPLAIN**: all three representative queries use Index / Index Only Scan
   on `Message_channelId_createdAt_id_idx` or `Message_pkey`, **no Sort
   node** (output captured in § Index Efficiency Proof below).
8. `.env.example` gains `MESSAGE_MAX_LENGTH`, `MESSAGE_RATE_USER_WINDOW_MS`,
   `MESSAGE_RATE_USER_MAX`, `MESSAGE_RATE_CHANNEL_MAX`.
9. `evals/tasks/010-012` added + `pnpm eval --dry-run` green.
10. Reviewer subagent spawned — report and resolution in § Reviewer below.

## Permission Matrix (extension only)

Matrix data lives in `apps/api/test/int/workspaces/permission-matrix.data.ts`;
task-004 adds 8 message entries. Test runner extended with `:chid` and
`:msgId` resolution + per-role message seeding so `msgTarget: 'self' | 'other'`
can pick the right message id.

| Endpoint                           | Anon | Non-member | Member                 | Admin | Owner |
| ---------------------------------- | ---- | ---------- | ---------------------- | ----- | ----- |
| GET /…/messages                    | 401  | 404        | 200                    | 200   | 200   |
| POST /…/messages                   | 401  | 404        | 201                    | 201   | 201   |
| GET /…/messages/:msgId             | 401  | 404        | 200                    | 200   | 200   |
| PATCH :msgId (self)                | 401  | 404        | 200                    | 200   | 200   |
| PATCH :msgId (other)               | 401  | 404        | 403 MESSAGE_NOT_AUTHOR | 403   | 403   |
| DELETE :msgId (self)               | 401  | 404        | 204                    | 204   | 204   |
| DELETE :msgId (other)              | 401  | 404        | 403 MESSAGE_NOT_AUTHOR | 204   | 204   |
| GET …/messages?includeDeleted=true | 401  | 404        | 403 INSUFFICIENT       | 200   | 200   |

Rationale — **PATCH** is author-only even for OWNER: editing someone else's
words is a moderation anti-pattern; delete-to-remove + re-post is the
sanctioned path. **DELETE** permits moderation (ADMIN+) in addition to self.

## Cursor Design Decision — Hybrid (Option A DTO + Option B query)

- **DTO**: `base64url(JSON.stringify({ t: ISO, id: UUID }))` — opaque to the
  client, decodable on the server with a strict schema validator that
  rejects missing fields, non-ISO `t`, and non-UUID `id`.
- **Query**: `$queryRawUnsafe` emits PostgreSQL row-value comparison
  `("createdAt", id) < ($1, $2)` (or `>` for `after=`), letting the planner
  use `Message_channelId_createdAt_id_idx` end-to-end. Prisma's builder
  generates an `OR`-of-`AND` form that the planner cannot merge into a
  single range scan past ~10k rows.

Why not pure Option A (Prisma builder): the read path is the hot path and
any Sort node landing here under load would be silent death.

Why not pure Option B (opaque raw): the DTO has to round-trip to the client,
and an opaque string is cheaper to reason about than exposing the row tuple.

`cursor.spec.ts` covers all 7 edge cases from the task spec: round-trip,
truncated base64, malformed JSON, missing `t`/`id`, non-UUID id, non-ISO t,
oversize token.

## Idempotency Design Decision — Option A (DB partial unique)

- Client-generated `Idempotency-Key: <uuid>` on POST (optional).
- DB index: `CREATE UNIQUE INDEX ... ON "Message"("authorId","channelId","idempotencyKey") WHERE "idempotencyKey" IS NOT NULL` — only keyed sends are indexed.
- Duplicate key + same content → service catches P2002, looks up the existing
  row, returns it with HTTP 200 and `Idempotency-Replayed: true`.
- Duplicate key + different content → 409 `IDEMPOTENCY_KEY_REUSE_CONFLICT`.
- No key → always create (two retries without a key = two rows, by design).

Why not Option B (Redis NX with 5-min TTL): task-005 reconnection can
legitimately retry a send minutes after disconnect (mobile background, LTE
handoff). A 5-min ceiling silently re-persists duplicates in that window —
the UX for the user is "I sent 'lol' once and it appeared twice."

5 concurrent same-key sends converge to 1 row: verified by
`messages.idempotency.int.spec.ts`.

## Index Rationale + EXPLAIN ANALYZE

Three indexes land in the migration:

```
Message_channelId_createdAt_id_idx      -- pagination primary path
Message_channelId_deletedAt_createdAt_idx   -- soft-delete filter
Message_authorId_idx                    -- future profile page / moderation
Message_authorId_channelId_idempotencyKey_unique  -- PARTIAL unique
```

Write amplification: 4 indexes × 1 insert = 4 tree writes. Partial unique
skips null-key rows entirely → no cost on the no-header path.

Captured from `scripts/explain-messages.ts` on 5 000 rows (ANALYZE'd):

```
==== Q1: initial page (newest 50, DESC) ====
Limit  (cost=0.28..5.55 rows=50 width=24) (actual time=0.019..0.051 rows=50 loops=1)
  ->  Index Scan Backward using "Message_channelId_createdAt_id_idx" on "Message"
        Index Cond: ("channelId" = '…'::uuid)
        Filter: ("deletedAt" IS NULL)
Execution Time: 0.075 ms

==== Q2: before cursor (row comparison) ====
Limit  (cost=0.29..5.68 rows=50 width=24) (actual time=0.025..0.056 rows=50 loops=1)
  ->  Index Scan Backward using "Message_channelId_createdAt_id_idx" on "Message"
        Index Cond: ("channelId" = '…' AND (ROW("createdAt", id) < ROW('…', '…')))
        Filter: ("deletedAt" IS NULL)
Execution Time: 0.111 ms

==== Q3: single-message lookup (PK) ====
Index Only Scan using "Message_pkey" on "Message"
  Index Cond: (id = '…'::uuid)
  Heap Fetches: 1
Execution Time: 0.227 ms
```

All three: Index Scan / Index Only Scan, **no Sort node**, sub-millisecond.
`messages.explain.int.spec.ts` asserts this invariant on the integration
stack and is eval task 012's gate.

## Outbox Event Schemas

Envelope (shared for all message events):

```ts
{
  id: string;               // OutboxEvent.id — dedupe key for subscribers
  type: 'message.created' | 'message.updated' | 'message.deleted';
  occurredAt: string;       // ISO
  aggregateType: 'Message';
  aggregateId: string;      // message id

  // payload fields (hoisted into the envelope by the dispatcher):
  workspaceId: string;
  channelId: string;
  actorId: string;
  message: {
    id: string;
    authorId: string;
    content?: string;       // omitted on deleted events
    mentions?: MessageMentions;
    createdAt?: string;     // created
    editedAt?: string;      // updated
    deletedAt?: string;     // deleted
  };
}
```

Task-005 WS handler: dedupe by `id`, route by `workspaceId + channelId`,
forward to Socket.IO room.

## Non-goals

- WebSocket broadcast (task-005).
- Attachments, threads, reactions (see § Scope OUT).

## Risks

- **Soft-delete leak** — every list path defaults to
  `deletedAt IS NULL`; `includeDeleted=true` is ADMIN+ gated. Matrix test
  covers the gate; service layer masks `content` to `null` in the DTO so
  even the admin path doesn't leak the original text unless the caller
  specifically targets GET `:msgId`.
- **Idempotency cardinality** — the partial unique index will grow
  unbounded as long as rows have a non-null `idempotencyKey`. The planner
  cost stays flat (btree over ~1M entries is still <20 µs lookup) but disk
  pressure is real. TODO(task-022): nightly batch null-processes keys older
  than 7 days.
- **Dispatcher at-least-once** — the envelope carries `id` explicitly so
  task-005's WS handler can dedupe; this is the contract.

## Progress Log

- `planner` — PLAN emitted; user picked the hybrid cursor + DB idempotency
  recommendations.
- `db-migrator` — migration `add_message_pagination_idempotency` with
  backfill + partial unique index (Prisma schema can't express partial
  indexes, raw SQL fills the gap).
- `implementer` — cursor util first (test-first), mention extractor second,
  service + controller + guard third; outbox records use the task-003
  `OutboxService.record(tx, …)` pattern.
- `tester` — 5 messages.\* int specs + extended permission-matrix (+8 cases
  with per-role seeded messages + redis RL bucket reset in `beforeEach`).
- `reviewer` — pending (spawned at REPORT step).
- `release-manager` — branch `feat/task-004-message`, commits split per the
  task prompt.
