# Task 014 Review — threads + 013 hygiene cleanup

**Reviewer**: reviewer subagent (general-purpose)
**Branch**: feat/task-014-threads-and-hygiene @ 8a88b25
**Base**: develop @ fa06e7d
**Transcript**: ~35k
**Verdict**: approve-with-followups

## A (hygiene) findings

- **A1 — Unified `ChannelAccessService` entry point**: verified.
  `apps/api/src/channels/permission/channel-access.service.ts:19-92` is
  the shared surface; it exposes `resolveEffective`,
  `requirePermission`, `requireVisibility`.
  `ChannelAccessGuard` (`apps/api/src/channels/guards/channel-access.guard.ts:22-91`)
  injects it and calls `access.resolveEffective` +
  `(effective & Permission.READ) !== Permission.READ` — previous
  `allowMask > 0` count is gone.
  `ChannelAccessByIdGuard`
  (`apps/api/src/attachments/guards/channel-access-by-id.guard.ts:19-35`)
  is now a thin adapter that delegates `requireRead` / `requireUpload`
  to `access.requirePermission`. No duplicated `PermissionMatrix.effective`
  fold remains. Module wiring in `channels.module.ts:26-39` and
  `attachments.module.ts:7-15` correctly exports/imports the new service.

- **A2 — `MessageCreatedPayload.message.parentMessageId` field +
  acceptance grep**: verified.
  `apps/api/src/messages/events/message-events.ts:22-24` adds
  `parentMessageId: string | null` to the nested `message` shape. Running
  `grep -rnE 'TODO\(task-009-low-1|TODO\(task-011-follow-7|TODO\(task-012-follow-13'`
  over `*.ts|*.tsx|*.sh` returns **0 lines** — the three deferred TODOs
  are all gone from source.

- **A3 — `MentionThrottle` exported + tested**: verified.
  `apps/web/src/features/realtime/dispatcher.ts:81` now reads
  `export class MentionThrottle`.
  `apps/web/src/features/realtime/mention-throttle.spec.ts` covers:
  capacity-5 bucket drain (`tryConsume: capacity-5 bucket drains then
refuses`), 1-second refill cap + 10s no-over-fill (`refills at 5
tokens/second — capped at 5`), collapse-one rollup with 7 over-budget
  events and single emission (`collapseOne aggregates…single 1s-delayed
toast`), and re-arm after timer fires (`collapseOne rearms after the
timer fires`). Uses `vi.useFakeTimers` with `vi.setSystemTime` per
  005 convention.

- **A4 — `.tmp` cleanup traps on backup scripts**: verified.
  `scripts/backup/db-backup.sh:36` — `trap 'rm -f "$OUT_FILE.tmp"' EXIT`.
  `scripts/backup/redis-backup.sh:37` — `trap 'rm -f "$OUT_FILE.tmp"
"$OUT_FILE.rdb" "$OUT_FILE.rdb.gz"' EXIT` covering both the
  `--rdb`-path and gzip-path interim artefacts. Both explain the
  post-`mv` no-op path in-comment.

- **A5 — Runbook "test-minio is TODO" paragraph resolved**: verified.
  `docs/ops/runbook-local-tests.md:89-96` now documents that
  task-013-A4 landed `test-minio` + `test-minio-init` and gives the
  `docker compose -f docker-compose.test.yml up` recipe. No residual
  TODO text.

## B (threads backend) findings

- **MED-1 (note, not blocker) — Channel unread counter bumps on replies**:
  `apps/web/src/features/realtime/dispatcher.ts:162-198` runs the
  channel-level unread-count bump BEFORE the `parentId` early return
  at :230. This is intentional per the task contract's Scope(OUT)
  section ("Per-thread unread badges — beta out; channel-level unread
  from 010 already covers replies via the underlying message"), so
  every reply increments the owner-channel unread. Worth documenting
  because it departs from Slack/Discord default (per-thread counts)
  but matches the contract. No action — calling out in case a follow-up
  sweep revisits.

- **Migration shape**: verified.
  `apps/api/prisma/migrations/20260423000000_add_message_parent_id/migration.sql`
  — single file:

  1. `ALTER TABLE "Message" ADD COLUMN "parentMessageId" UUID NULL
REFERENCES "Message"("id") ON DELETE SET NULL`
  2. Partial index `Message_channel_roots_idx` on
     `("channelId", "createdAt" DESC) WHERE "parentMessageId" IS NULL`
  3. Plain `Message_parentMessageId_createdAt_idx` on
     `("parentMessageId", "createdAt")` for the replies fetch.
     Top comment documents the CONCURRENTLY-prod deploy-hook path (Prisma
     can't run CONCURRENTLY inside a tx).

- **Prisma schema**: verified.
  `apps/api/prisma/schema.prisma:195` adds
  `parentMessageId String?  @db.Uuid`.
  `:201-202` defines `parent`/`replies` self-relation
  (`@relation("MessageReplies", …, onDelete: SetNull)`).
  `:214` adds `@@index([parentMessageId, createdAt])`. Partial index
  still only lives in the raw-SQL migration (Prisma has no predicate
  `@@index` syntax) — comment at :211-213 documents this.

- **Service-layer depth + parent validation**: verified.
  `apps/api/src/messages/messages.service.ts:231-248` (in `send`)
  pre-checks the parent row with
  `findFirst({ where: { id, channelId, deletedAt: null } })`:

  - missing parent → `MESSAGE_PARENT_NOT_FOUND` (404 per enum map at
    `error-code.enum.ts:101`)
  - `parent.parentMessageId !== null` → `MESSAGE_THREAD_DEPTH_EXCEEDED`
    (400 per :100). Both codes are new additions at :41-42.
    Integration spec `threads.int.spec.ts:60-85` exercises both paths.

- **`buildThreadReplyPayload` runs in the send tx**: verified.
  `messages.service.ts:334-353` calls `buildThreadReplyPayload` inside
  the `$transaction` block when `created.parentMessageId` is set, then
  `outbox.record(tx, …)` with `MESSAGE_THREAD_REPLIED`.
  Private method at :393-466 fetches replyCount + MAX(createdAt) in one
  raw COUNT + MAX query, then a second DISTINCT-ON query for the recent
  repliers (both on `(parentMessageId, createdAt)` index). Builds
  `recipients` starting with root author, appends up to
  `THREAD_REPLY_RECIPIENT_CAP = 20` (defined at
  `events/message-events.ts:72`), excludes replier, excludes anyone
  already in `excludeRecipients` (= mentioned set from the outer tx
  scope at `:306-310`). `recentReplyUserIds` = `recent.slice(0, 3)`.

- **`rawList` is roots-only**: verified.
  `messages.service.ts:591-601` SQL has
  `AND "parentMessageId" IS NULL` hard-coded on the channel-list path
  (comment at :587-590 explains why).
  Integration spec `messages-with-thread-summary.int.spec.ts:47-74`
  asserts the list returns 2 roots when 2 roots + 2 replies exist.

- **`aggregateThreadSummaries` is single-query / no-N+1**: verified.
  `messages.service.ts:135-177` uses a single
  `SELECT … COUNT(*), MAX("createdAt"), LATERAL COALESCE(ARRAY_AGG(…ORDER
BY last_at DESC), ARRAY[]) AS "recentReplyUserIds" … FROM "Message" m
… GROUP BY m."parentMessageId"`. The EXPLAIN int spec at
  `messages-with-thread-summary.int.spec.ts:99-121` asserts
  `Seq Scan on "Message"` is NOT in the plan for the 20-root seed.

- **`listThreadReplies` keyset paginates + rejects non-roots**: verified.
  `messages.service.ts:617-673` ASC cursor on `(createdAt, id) > (t, id)`
  via `$queryRawUnsafe`. Pre-check at :635-639 throws
  `MESSAGE_NOT_FOUND` when the id's row has `parentMessageId !== null`
  (catches a client trying to open a thread on a reply).
  `threads.int.spec.ts:116-124` exercises the non-root rejection.

- **`ThreadsController` ACL**: verified.
  `apps/api/src/messages/threads.controller.ts:20-102` —
  `@UseGuards(JwtAuthGuard)` + `@Controller('messages')`, single
  `@Get(':id/thread')` handler. Resolves the channel via `prisma.message
.findFirst` with the channel joined, then `await this.channelAccess
.requireRead(msg.channel, user.id)` at :69 — i.e. uses
  `ChannelAccessByIdGuard.requireRead`. Integration spec non-member
  test at :108-114 asserts 401/403/404.

- **`outbox-to-ws.subscriber` thread.replied fanout**: verified.
  `apps/api/src/realtime/projection/outbox-to-ws.subscriber.ts:60-77`
  branches on `env.type === 'message.thread.replied'`, iterates
  `recipients[]`, calls `replay.append('user', uid, …)` + `io.to(rooms
.user(uid)).emit(env.type, env)`. Channel-room fanout at :49-52 still
  runs (for sidebar summary patching); per-recipient user-room emit
  is additive. `replay.append` wrapped in try/catch with non-fatal log.

- **Integration specs present + aligned with PR.md claims**: verified.
  - `threads.int.spec.ts` covers: create reply (`:61-69`),
    depth-exceeded (`:71-78`), parent-not-found (`:80-85`), GET ordering
    ASC (`:89-106`), non-member 403-path (`:108-114`), reply-id-as-thread
    (`:116-124`), outbox shape (`:128-163`), mention-precedence dedupe
    (`:166-193`).
  - `messages-with-thread-summary.int.spec.ts`: replyCount aggregate
    - lastRepliedAt + recentReplyUserIds (`:48-74`), soft-deleted
      excluded (`:76-97`), EXPLAIN partial-index scan (`:99-121`).

## C (threads frontend) findings

- **MED-2 — Stale `activeThread` on channel switch**:
  `apps/web/src/shell/MessageColumn.tsx:37-42 + 145-162` owns `activeThread`
  via `useThreadQueryState`. `MessageColumn` in `Shell.tsx:82-87` is
  NOT keyed by channelId, so prop changes (channel switch) re-render
  without remounting. `useState(readInitial())` only runs on first
  mount, and the `popstate` listener only fires for browser back/
  forward — not for react-router pushState. Result: a user who opens
  thread X on channel A, then clicks channel B, keeps `activeThread=X`
  in React state even though the URL no longer carries `?thread=`, and
  the `ThreadPanel` will try to fetch replies for root X with
  `channelId=B`. The API's `listThreadReplies` will 404 on the channel
  mismatch (`MESSAGE_NOT_FOUND`), so it's cosmetic-bad not data-wrong,
  but the PR.md claim "channel change unmounts the panel and strips
  the URL param" is overstated — defer to a follow-up:
  `task-014-follow-1` — add `useEffect(() => setActiveThread(null), [channelId])`
  in MessageColumn OR key the component by channelId in Shell.

- **ThreadPanel structure + ESC/X close**: verified.
  `apps/web/src/features/threads/ThreadPanel.tsx:65-141`. Header with
  `data-testid="thread-close"` X button at :74-82. Body + composer
  split via `<Scrollable>` + footer. Global ESC binding at :55-61
  scoped to component mount lifetime. `ReplyComposer` at :144-194
  has `Enter` → submit, `Shift+Enter` → newline.

- **`useThread.ts` hooks**: verified.
  `useThreadReplies` at `:19-32` — `useInfiniteQuery` with
  `qk.messages.thread(rootId ?? '')` key, `limit: 50`,
  `getNextPageParam: hasMore ? nextCursor : undefined`, `enabled: !!rootId`.
  `useSendReply` at `:40-95` — optimistic insert at `onMutate`
  (tempId = `tmp-${crypto.randomUUID()}`, authorId='optimistic'),
  rollback via `ctx.prev` on error, replace tempId with server row on
  success. Calls `sendMessage(wsId, channelId, {content, parentMessageId:
rootId}, idempotencyKey)`.

- **Dispatcher message.created thread-reply branch**: verified.
  `apps/web/src/features/realtime/dispatcher.ts:200-230`. When
  `parentId` is set, patches `qk.messages.thread(parentId)` cache
  (dedup by id + optimistic tempId collapse by author='optimistic'

  - matching content) and `return`s, so the channel-list prepend
    at :233-257 is NOT reached for replies. Dispatcher unit spec at
    `dispatcher.spec.ts:214-298` asserts: `list` after a reply event
    stays at `['root-1']` (no reply), and `thread` cache gains the reply.

- **Dispatcher message.thread.replied handler**: verified.
  `dispatcher.ts:265-329`. Patches the root's `thread` field in the
  channel-list cache with server-authoritative `replyCount`,
  `lastRepliedAt`, `recentReplyUserIds`. Toast logic at :302-328:
  early returns when viewer not in recipients (:308) or viewer is the
  replier (:309). Uses a dedicated `replyThrottle = new MentionThrottle()`
  at :140 — separate instance from `mentionThrottle` at :136.
  Dispatcher spec at `:157-212` asserts the channel-cache root
  summary patch.

- **LOW-1 — `replyThrottle` is a `MentionThrottle` clone**:
  `dispatcher.ts:140` comment claims "5 toasts/min (slower refill)"
  but `MentionThrottle`'s hard-coded `refillPerSec = 5` means the
  reply throttle actually refills at 5/s just like the mention one.
  The contract at task-014.md:73 specified
  "5 replies/min per recipient (separate from mention's 5/sec cap)";
  the implementation just spawns a second instance with the same
  constants. Defer `task-014-follow-2` to either parametrize
  `MentionThrottle`'s rates in the constructor or drop the "5/min"
  comment.

- **`DISPATCHED_EVENTS` includes `message.thread.replied`**: verified.
  `dispatcher.ts:574`. Spec's `installs listeners for every dispatched
event type` (dispatcher.spec.ts:26-36) iterates `DISPATCHED_EVENTS`
  and asserts each is registered.

- **`MessageColumn` `?thread=` query-param state**: verified.
  `MessageColumn.tsx:37-42` reads param on init; `useThreadQueryState`
  at :145-162 wraps `useState` + `popstate` listener + `pushState` on
  set. See MED-2 above for the caveat.

- **`MessageItem` summary pill**: verified.
  `MessageItem.tsx:102-119` — `msg.thread && msg.thread.replyCount > 0`
  guard + `onOpenThread` callback. Testid `thread-open-<id>`.
  `MessageList.tsx:100-102` passes `onOpenThread` only for non-temp
  rows.

- **E2E**: verified.
  `apps/web/e2e/messages/thread-replies.e2e.ts` — signup → create
  workspace → create channel → post root → API-post reply → expect
  `thread-open-${rootId}` visible → click → expect `thread-panel`
  visible → fill + send → expect rendered → click X → expect panel
  count=0.

## Cross-cutting

- **No new `any` casts in business code**: verified.
  `grep -n ': any|as any|any\[\]'` on `apps/api/src/messages/` and
  `apps/web/src/features/threads/` returns no matches.

- **`shared-types/src/message.ts` back-compat**: verified.
  `:60-61` — `parentMessageId: z.string().uuid().nullable().default(null)`

  - `thread: ThreadSummarySchema.nullable().default(null)`. Older
    payloads that lack these fields parse to `null` defaults, so the
    dispatcher's optional chaining path (`env.message.parentMessageId ?? null`)
    never throws.

- **`ErrorCode` enum + shared-types `ErrorCodeSchema` both list the
  new codes**: verified.
  `apps/api/src/common/errors/error-code.enum.ts:41-42 + :100-101`.
  `packages/shared-types/src/index.ts:78-79`. Pre-existing drift
  (ATTACHMENT\_\*, CHANNEL_NOT_VISIBLE, FORBIDDEN, INVITE_REVOKED
  missing from `ErrorCodeSchema`) is NOT introduced by 014 — check
  git blame at `fa06e7d` confirms this. Flag for a future hygiene
  sweep (task-014-follow-3 — or roll into the next broad cleanup).

- **`message.created` payload backward-compat**: verified.
  `apps/api/src/messages/events/message-events.ts:22-24` makes the
  new field non-optional on the server side (always set — null for
  roots), but the Zod DTO default at `message.ts:60` is
  `.nullable().default(null)` — so existing 005/011/013 dispatcher
  branches that parse the envelope and don't read the field keep
  working. Dispatcher's thread-reply routing checks `env.message
.parentMessageId ?? null` at `dispatcher.ts:203` — ?? null is
  robust to `undefined` too.

- **No destructive migration on dev/test; down drops column on
  populated prod orphans replies — documented**: verified.
  Migration SQL top comment (`:1-17`) and PR.md both call out the
  destructive-on-populated-prod down-path.

- **Commit messages follow Conventional Commits**: verified.

  ```
  refactor(hygiene): task-014-A — 013 deferred cleanup (4 items)
  feat(threads): task-014-B — parentMessageId self-FK + roots-only list + thread endpoint
  feat(threads): task-014-C — ThreadPanel + dispatcher routes + thread summary on root messages
  docs(task-014): threads + hygiene cleanup task contract
  ```

- **No secrets committed**: verified.
  `git diff fa06e7d..8a88b25 --name-only | grep -E '\.env|secret|password'`
  returns no matches.

- **Eval added**: verified. `evals/tasks/029-thread-replies.yaml`
  exists in the directory listing.

## Deferred to task-014-follow-\*

1. **task-014-follow-1 (MED)** — `MessageColumn.tsx` does not clear
   `activeThread` on channel switch; the URL param is stripped on
   navigation but the React state persists. Either add
   `useEffect(() => setActiveThread(null), [channelId])` to
   `MessageColumn`, or give the component a `key={channelId}` at the
   `Shell.tsx` call site so it remounts per channel.

2. **task-014-follow-2 (LOW)** — Reply throttle claims "5/min" in
   comment but shares `MentionThrottle`'s hard-coded `refillPerSec=5`,
   so it's actually 5/sec. Either parametrize the class or update the
   comment + task contract to match implementation.

3. **task-014-follow-3 (LOW)** — Pre-existing drift in
   `packages/shared-types/src/index.ts`'s `ErrorCodeSchema`: missing
   ATTACHMENT\_\*, CHANNEL_NOT_VISIBLE, FORBIDDEN, INVITE_REVOKED
   compared to the backend enum. Not a 014 regression — roll into
   the next hygiene sweep.
