# Task 014 PR — Message Threads + 013 Deferred Hygiene Cleanup

**Branch:** `feat/task-014-threads-and-hygiene`
**Base:** `develop` (`fa06e7d`)
**Merge style:** direct `git merge --no-ff` to develop (skip PR — 011/012/013 convention)
**Memory:** `feedback_skip_pr_direct_merge.md` / `feedback_retain_feature_branches.md` / `feedback_handoff_must_include_report.md`

## Summary

- **A** — 4 follow-ups from task-013 landed:
  - `ChannelAccessService` now holds the override fetch + `PermissionMatrix.effective` fold. `ChannelAccessGuard` (URL-path CanActivate) and `ChannelAccessByIdGuard` (body-param injectable) both delegate to it, so the channel ACL path is one place to read. Replaces the guard's previous `allowMask > 0` count that drifted from the full mask compute used by attachments / reactions. (task-012-follow-13)
  - `MentionThrottle` exported + unit-tested with `vi.useFakeTimers`: bucket drain, 1s refill cap, collapseOne's 1-second rollup, re-arm after emit. (task-011-follow-7)
  - `db-backup.sh` / `redis-backup.sh` gain `trap 'rm -f "$OUT_FILE.tmp" …' EXIT` so ENOSPC / SIGTERM doesn't leave a half-written file for the next scheduled run. (task-009-low-1)
  - `docs/ops/runbook-local-tests.md` "Attachment E2E on the NAS" paragraph refreshed now that task-013-A4 landed `test-minio` in the test compose. (task-013-follow-1)
- **B** — Threads backend:
  - Prisma `Message.parentMessageId` self-FK (ON DELETE SET NULL). Single-level depth enforced at the service (parent.parentMessageId must be null; else `MESSAGE_THREAD_DEPTH_EXCEEDED`). Two indexes: partial `(channelId, createdAt DESC) WHERE parentMessageId IS NULL` + `(parentMessageId, createdAt)`.
  - `GET /workspaces/:w/channels/:ch/messages` is now ROOTS ONLY; DTO grows `thread: { replyCount, lastRepliedAt, recentReplyUserIds } | null` via a single GROUP BY + LATERAL subquery — no N+1. EXPLAIN int spec asserts partial index scan, no seq scan.
  - New endpoint `GET /messages/:id/thread?cursor&limit` returns the root + ASC-ordered replies. Gated by `ChannelAccessByIdGuard.requireRead`.
  - Outbox: `message.created` payload gains `parentMessageId` (additive; older dispatcher branches ignore it). New `message.thread.replied` event carries server-authoritative `replyCount` + `lastRepliedAt` + `recentReplyUserIds` (top 3) + `recipients` (root author + up to 19 recent repliers, cap 20, minus already-mentioned users).
  - `outbox-to-ws.subscriber` fans `message.thread.replied` to each recipient's user room with replay.append on top of the existing channel-room fanout.
- **C** — Threads frontend:
  - `features/threads/ThreadPanel.tsx` — header root + body replies + inline `ReplyComposer`. ESC closes, X closes, channel change unmounts the panel and strips the URL param.
  - `features/threads/useThread.ts` — `useThreadReplies` infinite query + `useSendReply` optimistic insert (tempId collapses via WS echo).
  - Dispatcher's `message.created` branch routes replies (parentMessageId set) into the thread cache, NEVER the channel list — matches the backend roots-only contract. Dispatcher `message.thread.replied` patches root's `thread` summary authoritatively + fires reply toast via a dedicated `MentionThrottle` instance so reply traffic throttles independently of mentions.
  - `MessageColumn` owns the `?thread=<rootId>` URL query param state; sharing reopens the panel.
  - `MessageItem` shows a `💬 count` pill on root messages with `replyCount > 0`; click opens the panel.
  - E2E `thread-replies.e2e.ts`: post root, API reply bumps the pill, UI open + reply from panel, close via X.

## Verify

```
pnpm verify → green
```

Tasks: 19/19 success, 0 errors, warnings only.

- `@qufox/api:typecheck` ✓
- `@qufox/shared-types:test` ✓ (8 tests)
- `@qufox/api:test` ✓ (59 tests — no new unit specs; B+C coverage lives in int + dispatcher.spec)
- `@qufox/web:test` ✓ (12 tests: 10 base + `upsertReactionBucket` + 2 new thread branches)
- `@qufox/web:typecheck` ✓

## New int specs (run on GHA)

- `apps/api/test/int/messages/threads.int.spec.ts` — reply create, depth-exceeded, parent-not-found, GET /thread ACL, ordering, outbox shape, mention-dedupe
- `apps/api/test/int/messages/messages-with-thread-summary.int.spec.ts` — replyCount aggregate, soft-deleted exclusion, EXPLAIN partial-index scan

## Migration

`apps/api/prisma/migrations/20260423000000_add_message_parent_id/` — additive column + two indexes.

**Down script:** dropping `parentMessageId` orphans any reply rows (replies survive with `parentMessageId` gone entirely after column drop). Acceptable for dev / staging migrate-down; documented as destructive on a populated prod DB. For the production rollout the two CREATE INDEX statements should be converted to `CREATE INDEX CONCURRENTLY` to avoid AccessExclusive on `Message` — Prisma can't run CONCURRENTLY inside a migration transaction, so that runs as a separate deploy hook.

## Commits

```
8a88b25 feat(threads): task-014-C — ThreadPanel + dispatcher routes + thread summary on root messages
8843ab9 feat(threads): task-014-B — parentMessageId self-FK + roots-only list + thread endpoint
124d6fe refactor(hygiene): task-014-A — 013 deferred cleanup (4 items)
252723e docs(task-014): threads + hygiene cleanup task contract
```

## Acceptance grep evidence

```
$ grep -rnE 'TODO\(task-009-low-1|TODO\(task-011-follow-7|TODO\(task-012-follow-13' \
    --include='*.ts' --include='*.tsx' --include='*.sh' .
(no output)
```
