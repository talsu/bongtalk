# task-026 Review — Activity Inbox + Mobile DS Parity + Icon Swap

Branch: feat/task-026-activity-inbox-and-mobile-ds-parity (4 commits, tip d582d13)
Reviewer pass: adversarial re-read against docs/tasks/026-\*.md.

## Summary

9 chunks A..I landed. API adds UserActivityReadState migration + UNION
query over messages(mentions) + messages(reply-to-my-root) +
message_reactions, with ACL mirroring me-mentions. Web adds /activity
route with mobile/desktop branch, mobile DS parity (qf-m-search,
qf-m-segment, qf-m-fab, qf-m-row**primary/**aside, qf-m-tab**badge/**dot),
and bell badge. qf-m-\* grep 78 → 133 (+55, target ≥120 met). UI chrome
emoji in apps/web/src/shell/: 0 (sole match is `MobileMessageSheet`
QUICK reaction content — explicitly preserved per task H rule). DS
assets under apps/web/public/design-system/ — git diff HEAD~3 empty,
source-of-truth preserved. 7 new e2e specs; invites endpoint
`/invites/:code/accept` verified to exist (invites.controller.ts:99).

## BLOCKER

None.

## HIGH

None. SQL uses Prisma tagged templates exclusively — every interpolation
($queryRaw) is parameterized, no string concat. ACL `acc` CTE joins
WorkspaceMember + private-channel override mask; reactor ACL is
implicit (reactor must have been able to reach the message to react,
and we filter by message authorId = me so the message is always
visible to the owner).

## MEDIUM

1. **Reply detection is single-level.** `replies` CTE matches where
   `root.id = m.parentMessageId AND root.authorId = me`. If thread
   model ever allows reply-to-reply (grandchild), those grandchildren
   miss the inbox. Current Message model stores only parentMessageId
   (1 level), so this is accurate today — but document as an
   explicit limitation in PR.md + TODO(task-026-follow-nested-reply)
   if threads deepen.
2. **markAllRead only reads page(limit=50).** If a user has >50
   unread, a single read-all call clears only the first page. Acceptable
   for MVP but worth a TODO — consider loop-until-empty or
   executeRaw upsert from the unread CTE directly.

## LOW

1. **Cursor "<iso>|<activityKey>" url encoding.** `|` is reserved-ish
   in query strings; useActivityList uses
   `encodeURIComponent(filter)` but does not encode cursor when it
   threads back. Practically the service only parses split('|'), but
   future pagination should `encodeURIComponent(cursor)` on the
   client.
2. **Route-level matchMedia is one-shot at mount.** Resizing across
   the 767px breakpoint while on /activity keeps the original tree.
   Rare on real devices.
3. **Optimistic read flicker on settle.** invalidateQueries in
   onSettled may briefly re-show unread if the server replay lags
   the mutation ack. Acceptable; React Query reconciles within one
   tick.
4. **Unread total math** sums per-kind from the GROUP BY — correct
   because the LEFT JOIN `WHERE rs.id IS NULL` filters before COUNT.
5. **VR baseline reseed skipped** — documented as
   TODO(task-026-follow-vr-reseed); acceptable given visual churn.

## Verdict

APPROVE. No BLOCKER/HIGH. MEDIUM items are documentable limitations,
not bugs. Merge feat/task-026-activity-inbox-and-mobile-ds-parity →
develop with --no-ff, then develop → main auto-promote.
