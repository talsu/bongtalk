# Task 014 — Message Threads + 013 Deferred Hygiene Cleanup

## Context

Task 013 resolved 10 of 15 priority follow-ups and shipped Reactions

- MinIO naming hygiene; four items deferred. This task absorbs the
  deferred four and ships the last big MVP feature on top of the message
  system — Threads.

Threads sit naturally on top of 005's outbox/dispatcher, 010's unread
state, 011's mention notify, 012's permission overrides, and 013's
reactions. Single-level depth (Slack-style), no model surgery beyond
adding `parentMessageId` to `Message`. Reply notifications reuse the
mention pipeline.

## Scope (IN)

### A. 013 deferred hygiene (4 items)

UNDERSTAND step verifies each TODO marker is still live; resolved
items get the marker removed and review.md status updated.

| Item                                                                                                 | Source                | Priority        |
| ---------------------------------------------------------------------------------------------------- | --------------------- | --------------- |
| `ChannelAccessGuard` + `ChannelAccessByIdGuard` unified entry point                                  | 012-follow-13 partial | MED (structure) |
| `MentionThrottle` unit test (injected `fakeClock`, 005 pattern)                                      | 011-follow-7          | MED             |
| `.tmp` orphan trap in `db-backup.sh` and `redis-backup.sh` (`trap 'rm -f "$OUT_FILE.tmp"' ERR EXIT`) | 009-low-1             | LOW             |
| `runbook-local-tests.md:89-96` residual TODO paragraph                                               | 013 NIT               | NIT             |

### B. Threads backend (closes TODO(task-024))

- Prisma `Message` table gains:
  ```
  parentMessageId  uuid? FK -> Message.id ON DELETE SET NULL
  ```
  Single self-FK. Single-level depth enforced at service layer
  (parent-of-parent must be NULL; rejected with
  `MESSAGE_THREAD_DEPTH_EXCEEDED` 400 if not).
- Two indexes:
  - `(channelId, createdAt DESC) WHERE parentMessageId IS NULL`
    — partial index for the channel-roots query.
  - `(parentMessageId, createdAt ASC)` — replies fetch.
- API changes:
  - `POST /channels/:chid/messages` body extended with optional
    `parentMessageId: uuid`. Validates: parent exists, same channel,
    parent's `parentMessageId IS NULL`.
  - `GET /channels/:chid/messages` is now **roots-only**
    (`WHERE parentMessageId IS NULL`). Response DTO grows three
    fields per root:
    - `replyCount: int`
    - `lastRepliedAt: timestamptz | null`
    - `recentReplyUserIds: uuid[]` (max 3, for avatar stack)
    - All three computed in a single GROUP BY join — N+1 forbidden,
      EXPLAIN-asserted.
  - `GET /messages/:id/thread?cursor&limit=50` — new endpoint.
    Returns the root's replies, cursor-paginated by createdAt ASC.
    ACL: caller must have READ on the channel.
- Outbox events:
  - Existing `message.created` payload extended with
    `parentMessageId` (nullable). Schema versioned via shared-types
    schema bump; back-compat: dispatcher branches that don't read
    the field still work.
  - New `message.thread.replied { rootMessageId, channelId,
workspaceId, replierId, replyCount, lastRepliedAt }` — emitted
    on every reply. Recipients: root author + the most recent N
    repliers (cap N=20 — beta-grade fan-out limit).
- Reply notifications (mention dispatcher pattern reuse):
  - `mention.received` and `message.thread.replied` are routed
    through the same per-user toast queue. `variant` differentiates
    presentation (`mention` vs `reply`).
  - Throttle: 5 replies/min per recipient (separate from mention's
    5/sec cap). Excess collapses to "+N more replies" toast.
  - Dedup: if the reply also `@`s the same recipient, only the
    mention toast fires (mention takes precedence — it's more
    specific).
- ACL: parent message's channel READ + WRITE_MESSAGE for replying;
  no new permission bit.

### C. Threads frontend

- `MessageItem` reply summary on root messages:
  - `[💬 4 replies] [Avatar1, Avatar2 + 1] last reply 2m ago`
  - Click opens the right-side `ThreadPanel` (mobile: full screen).
- New `features/threads/ThreadPanel.tsx`:
  - Header shows the root message.
  - Body lists replies, cursor pagination via `useThreadReplies`.
  - Footer: a `MessageComposer` instance bound to the root's
    `messageId` as `parentMessageId`.
  - Close via X button, ESC, channel change, or removing the
    `?thread=` query param.
- URL: `/w/:wsSlug/c/:channelSlug?thread=<rootMessageId>` — query
  param, not a new route. Sharing the URL opens the thread.
- Realtime dispatcher branches:
  - `message.created` with `parentMessageId === activeThreadRoot`:
    append to active thread reply list.
  - `message.created` with `parentMessageId === <some root in
current channel>` (regardless of active thread): bump that
    root's `replyCount`, `lastRepliedAt`, and recent avatars.
  - `message.thread.replied` (the explicit aggregate event): patch
    the root in the channel cache. Idempotent with the inferred
    bump from `message.created` so dispatcher dedupe by event id.
  - `mention.received` + `message.thread.replied` for the same
    recipient + same message: dispatcher dedupes, mention wins.
  - Unit test in `dispatcher.test`: cover both branches +
    cross-feature dedupe.
- E2E `apps/web/e2e/thread-replies.e2e.ts`:
  - 2 contexts. A posts root in channel C. B replies. A's root
    shows replyCount=1 within 2s; B's ThreadPanel shows the reply.
  - A opens ThreadPanel and replies; A self-receives no toast.
  - C posts a reply that also `@`s A: A receives one toast
    (mention variant), not two.

## Scope (OUT) — future tasks

- Multi-level threads (depth > 1) — Slack-style is enough for beta.
- Inline reply preview rendered inside the channel list (Discord
  style) — out, would clutter the timeline.
- Per-thread unread badges — beta out; channel-level unread from
  010 already covers replies via the underlying message.
- Thread "follow" / "subscribe" / "mute" — out.
- Thread auto-archive after N days of inactivity — out.
- FTS — TODO(task-025).
- Beta operations (admin onboarding, whitelist, feedback widget).
- PITR / WAL archiving — separate ops task.
- sops / age secret encryption — separate ops task.
- Loki self-hosted — TODO(task-019).
- Custom emoji upload (image-backed reactions) — separate task.
- Residual LOW/NIT follow-ups from 010/011/012/009 — defer to a
  later hygiene sweep.

## Acceptance Criteria (mechanical)

- `pnpm verify` green. Log attached to `docs/tasks/014-*.PR.md`.
- `pnpm --filter @qufox/api test:int` green on GitHub Actions.
  New specs:
  - `threads.int.spec.ts` (root + reply create, depth-exceeded
    rejection, ACL, parent-not-found rejection)
  - `messages-with-thread-summary.int.spec.ts` (replyCount
    aggregate, lastRepliedAt, recentReplyUserIds, EXPLAIN single
    query)
- `pnpm --filter @qufox/web test:e2e` green on GHA:
  - `thread-replies.e2e.ts` newly added.
- One Prisma migration, **reversible-first**:
  - `add_message_parent_id.sql` + down (down drops the column;
    down script comment notes that any reply rows lose their
    parent FK, which is acceptable for migrate-down on a fresh
    DB but documented as destructive in the runbook).
- Hygiene TODO regression:
  - `grep -rn 'TODO(task-009-low-1\|TODO(task-011-follow-7\|TODO(task-012-follow-13' --include='*.ts' --include='*.tsx' --include='*.sh' .` returns **0 lines**.
  - `runbook-local-tests.md`'s residual TODO paragraph removed
    or resolved.
- EXPLAIN evidence in `014-*.PR.md` — `GET /channels/:chid/
messages` (roots + replyCount aggregate) → index scan, no seq
  scan, single round trip.
- Outbox `message.created` payload extension does NOT break 005,
  011, 013 dispatcher specs (back-compat asserted).
- Three artefacts: `014-*.md`, `014-*.PR.md`, `014-*.review.md`.
- One eval added: `evals/tasks/029-thread-replies.yaml`.
- Reviewer subagent **actually spawned**; transcript token count
  recorded in `014-*.review.md` header.
- **Direct merge to develop** (PR creation skipped). Commit
  message: `Merge task-014: threads + hygiene cleanup`.
- **REPORT printed to chat automatically** after merge — without
  the user asking. Per `feedback_handoff_must_include_report.md`.
- Feature branch retained (no deletion prompt). Per
  `feedback_retain_feature_branches.md`.

## Prerequisite outcomes

- 013 merged to develop (`fa06e7d`).
- GHA `integration` + `e2e` workflows green on the 014 branch
  before merge.
- `MessageReaction` schema from 013 unaffected by this task
  (different table, no FK overlap with new `parentMessageId`).

## Design Decisions

### Single-level depth, enforced at service layer

DB CHECK constraints can't reference other rows in vanilla
Postgres without triggers. Triggers are heavier than a service-
layer check that runs once per write. The check is: when
`parentMessageId` is provided, fetch the parent in the same
transaction and reject if `parent.parentMessageId !== null`.

### Channel messages list returns roots only

Returning every message including replies would intermix replies
between unrelated roots in the timeline — confusing UX. Slack and
Discord both hide replies from the channel list and surface them
through a thread side panel. Adopting that pattern keeps the web
UI's `MessageList` semantically the same (it already only renders
what the API gives it). Mobile / external clients don't exist
yet, so no other consumer is affected.

### `replyCount` is aggregated, not denormalized

Denormalizing into `Message.replyCount` would mean every reply
write hits the root row's counter — write contention on hot
threads. The GROUP BY against `(parentMessageId, createdAt)`
indexes is a single index scan, sub-millisecond per channel page.
If a channel ever reaches 100k+ replies on a single root,
denormalization becomes worth it; for now, the aggregate path is
simpler and safer.

### Thread URL is a query string, not a route

`?thread=<rootId>` keeps the thread state subordinate to the
channel route. Closing the thread is just removing the query
param; sharing the URL opens the thread anywhere. Matches the
pattern 008 already uses for ephemeral state.

### Reply notification reuses mention pipeline

`mention.received` already has dispatcher routing, throttle, toast
queue, browser Notification. Adding a second variant to the same
pipeline costs one branch and one variant key. Reply throttle
(5/min) is separate from mention (5/sec) because reply traffic is
inherently slower per recipient.

### Mention takes precedence over reply on the same message

If C's reply also `@`s A, A would otherwise get two toasts. The
dispatcher dedupes by `(messageId, recipientId)` and prefers the
mention variant — mention is more specific (the user was
explicitly named) and reply is a lighter signal (the message is
in a thread the user participated in).

## Non-goals

- Reaction notifications, reaction badges in sidebar — out.
- Thread search — out (covered by FTS later).
- Anything that changes the channel-level unread model from 010.

## Risks

- **Migration is metadata-only, indexes need CONCURRENTLY** —
  Postgres `ALTER TABLE ADD COLUMN parentMessageId uuid NULL` is
  metadata-only (instant). The two new indexes are non-trivial on
  a populated `messages` table. Use `CREATE INDEX CONCURRENTLY` —
  cannot run inside a transaction, so the migration must be split:
  Prisma generates the column DDL, raw SQL appendix runs the
  CONCURRENTLY index. Document in PR.md.
- **`replyCount` aggregate cost** — at 50 channel roots × ~5
  replies each, the LATERAL aggregate runs 50 times per page.
  EXPLAIN expects index scan on `(parentMessageId, createdAt)`,
  total < 5ms. If EXPLAIN shows seq scan, add the index OR fold
  the aggregate into a window function over the join — implementer
  chooses based on planner output.
- **Outbox `message.created` schema bump** — adding
  `parentMessageId` to the event is backward-compatible if every
  consumer treats unknown fields as ignorable (which the 005
  dispatcher does). 011/013 dispatchers must be re-tested
  against the new payload — `dispatcher.test` covers.
- **ThreadPanel UX on channel switch** — leaving the panel open
  when the user clicks a different channel is confusing (which
  thread is this?). Mitigation: switching channels removes the
  `?thread=` param and closes the panel; if the user navigates
  via browser back, the URL restores the thread state.
- **Reply notification fan-out** — root + 20 recent repliers =
  21 events per reply. At beta scale this is fine; at scale it
  warrants a per-thread "follower" set (TODO(task-024-follow-1)
  if reviewer raises).
- **Migration down drops `parentMessageId`** — replies in the DB
  lose their parent reference (rows survive, FK gone). Down script
  comment + runbook entry both mark this as destructive on a
  populated DB. Acceptable for develop / staging; a real prod
  rollback would require a per-row backup we don't have today.
  Document, don't fix.
- **Self-FK ON DELETE SET NULL turns replies into orphan
  pseudo-roots** — if a root message is hard-deleted (out of
  scope for soft-delete; only purge-worker), its replies'
  `parentMessageId` becomes NULL and they appear as roots in the
  next channel list query. Acceptable for now (purge worker is
  rare); a future task can introduce a separate "deleted
  parent" placeholder.

## Progress Log

_Implementer fills this section. Three commit groups: A
(hygiene), B (threads backend), C (threads frontend). Order
A → B → C is recommended so the 4-item cleanup is in master
state before the bigger feature scaffolds._

- [ ] UNDERSTAND (013 hygiene grep, channel messages-list
      consumer audit)
- [ ] PLAN approved
- [ ] SCAFFOLD (migration red, threads service stub)
- [ ] IMPLEMENT (A → B → C)
- [ ] VERIFY (`pnpm verify` after each + GHA green)
- [ ] OBSERVE (EXPLAIN captured, thread E2E trace uploaded,
      reply throttle metric visible)
- [ ] REFACTOR
- [ ] REPORT (PR.md, reviewer spawned, eval added, direct merge
      to develop, **REPORT printed automatically**)
