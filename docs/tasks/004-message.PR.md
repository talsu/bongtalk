## Summary

Delivers the Message domain — the primary UX of the platform — on top of
task-003's channel/outbox foundation. Text CRUD + opaque cursor pagination
(bi-directional + around-anchor) + idempotent send + mention extraction

- rate limits. **No Sort node** in the hot read path (Index Scan on
  `Message_channelId_createdAt_id_idx`, verified by dedicated integration
  test). Task-005 Realtime can consume the outbox envelope as-is.

## Design decisions (with "why not the alternative")

- **Cursor = hybrid**: opaque `base64url(JSON({t,id}))` DTO + raw
  PostgreSQL row-value comparison `("createdAt", id) < ($1,$2)` in the
  query. Prisma's builder emits an OR-of-AND form that degrades to Sort
  past ~10k rows; the read path is the hot path.
- **Idempotency = DB partial unique**: `UNIQUE (authorId, channelId,
idempotencyKey) WHERE idempotencyKey IS NOT NULL`. Task-005 reconnection
  retries can legitimately arrive minutes after the original send — a
  Redis-NX 5-min TTL would silently double-insert past that window.
- **PATCH author-only, DELETE author-or-ADMIN+**: editing someone else's
  words is a moderation anti-pattern (delete+repost is the sanctioned
  path); removing is a legitimate moderator action.

## Index efficiency proof

```
Q1 initial page (newest 50, DESC):
  Index Scan Backward using "Message_channelId_createdAt_id_idx"
  Filter: ("deletedAt" IS NULL)
  Execution Time: 0.075 ms  (5 000 rows seeded)

Q2 before cursor (row comparison):
  Index Scan Backward using "Message_channelId_createdAt_id_idx"
  Index Cond: ROW("createdAt", id) < ROW('…', '…')
  Execution Time: 0.111 ms

Q3 single message (PK):
  Index Only Scan using "Message_pkey"
  Execution Time: 0.227 ms
```

All three: **no Sort node**. Asserted by
`messages.explain.int.spec.ts` + captured in `docs/tasks/004-message.md`.

## Correctness evidence

- **5 concurrent same-key sends → exactly 1 DB row, 4 replayed**
  (`messages.idempotency.int.spec.ts`).
- **Concurrent insert during pagination — no dup, no skip**
  (`messages.pagination.int.spec.ts`: seed 100, page through 2 pages of
  25, insert 5 at head, page through 2 more → all 100 original ids
  present across 4 pages, 0 duplicates).
- **7 cursor edge cases** covered in `cursor.spec.ts`.
- **Permission matrix +8** cases, including the OWNER-cannot-edit-other's
  message rule as `403:MESSAGE_NOT_AUTHOR`.
- **Soft-delete leak fixed** (reviewer finding 1): non-admin 404s on
  `GET :msgId` for deleted rows.

## Verification (full `pnpm verify` + `test:int` + guard coverage)

- `pnpm verify` exit 0, 16/16 tasks
- `pnpm test:int` — **183/183 tests, 15 files**
- `scripts/check-guard-coverage.ts` — **30/30 routes guarded**
- `pnpm audit --prod --audit-level=high` — 0 high/critical

## Reviewer subagent

**approve-with-comments, no blockers.** 3 of 6 non-blocking findings
(soft-delete leak on GET, dead ref in web, defensive `update()`) applied
in commit 7. Full reviewer report at `docs/tasks/004-message.review.md`.

## Test plan

- [x] `pnpm verify`
- [x] `pnpm --filter @qufox/api test:int`
- [ ] `pnpm --filter @qufox/web test:e2e` (dockerized Playwright — run in CI)
- [x] `scripts/check-guard-coverage.ts`
- [x] `scripts/explain-messages.ts` against dev DB

🤖 Generated with [Claude Code](https://claude.com/claude-code)
