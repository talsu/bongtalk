# Task 004 — Reviewer Report

Independent review run by the general-purpose subagent against
`feat/task-004-message` (commits `0b72864..59d916a`).

## Verdict

**approve-with-comments** — no blockers. All non-blocking suggestions scoped
as listed below; 1/2/3 applied in a follow-up commit, 4/5/6 deferred with
TODO comments.

## Reviewer output (verbatim, condensed)

> **BLOCKERS**: none that rise to "must reship" severity. The soft-delete
> leak via GET :msgId is the closest, but content IS masked in toDto, so
> it's bounded existence-disclosure rather than content leak. Flagging as
> non-blocking given MVP scope.
>
> **Non-blocking**:
>
> 1. Soft-delete leak on GET /messages/:msgId — non-admin MEMBER can confirm
>    the row's existence by id (content masked, metadata still visible).
> 2. Dead `pendingRef` in `apps/web/src/features/messages/useMessages.ts`
>    — ref is written and deleted but never read.
> 3. Channel-scope rate limit is a griefing vector (one spammer → 429 for
>    channel).
> 4. `RateLimitService.enforce` counts idempotency replays as attempts.
> 5. `update()` doesn't guard against editing soft-deleted rows when called
>    outside the controller.
> 6. Misleading test comment in `messages.events.int.spec.ts` — "tx
>    rollback" actually tests pre-tx guard rejection.
>
> **Compliments**: row-value comparison + EXPLAIN test genuinely prove the
> design; 5-concurrent idempotency test asserts exactly 1 DB row; around=
> dedupe via Map+sort is correct; matrix locks the OWNER-cannot-edit rule.

## Resolution in this branch

| #   | Finding                          | Action                                                                                                                                                                               |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Soft-delete leak on `GET :msgId` | **Fixed** — `getOne` gains `includeDeleted` flag; controller passes `isAdminOrOwner(m.role)`. Non-admin now gets 404 on deleted rows. Test coverage added in `messages.int.spec.ts`. |
| 2   | Dead `pendingRef`                | **Fixed** — removed the unused map; `useRef` import dropped.                                                                                                                         |
| 3   | Channel griefing                 | Deferred. Ships as-is for MVP; TODO(task-018 billing/caps) will revisit with per-user-per-channel buckets.                                                                           |
| 4   | Replays count against rate limit | Deferred. Low priority — replays are fast and rare in practice. TODO(task-022).                                                                                                      |
| 5   | `update()` defensive guard       | **Fixed** — switched to `updateMany` scoped by `(id, channelId, deletedAt: null)` + `count===0 → MESSAGE_NOT_FOUND`.                                                                 |
| 6   | Misleading test comment          | **Fixed** — renamed test + added clarifying comment that points at the idempotency 409 path for genuine in-tx rollback coverage.                                                     |

## Delta commit

`fix(message): reviewer follow-ups — soft-delete leak, dead ref, defensive update`
— applies findings 1, 2, 5, 6 in a single commit.
