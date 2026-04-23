# Reviewer — task-032 Friends system (F-2)

Branch `feat/task-032-friends-system` @ `4f76935`.

## Verdict

**CHANGES REQUESTED** — core CRUD/DB is solid, but chunk E
("019 + 026 알림 통합") and the 027 DM-block hook are materially
unimplemented despite being called out in Scope (IN) and Acceptance
Criteria. Shipping as-is leaves two contract items unfulfilled.

## Findings

### HIGH

1. **Dispatcher / outbox integration absent.** Contract E requires
   `friend.request.received` + `friend.request.accepted` outbox events,
   plus frontend dispatcher branches (toast + Activity invalidate +
   pending_incoming count bump). `friends.service.ts` updates rows
   only; no event emit, no `NotificationService` call.
   `grep friend.request.received apps/api/src` → 0 hits. This also
   defeats `friend-notification-integration.e2e.ts` (spec must be
   validating the preference row silently, not the dispatcher path).

2. **026 Activity UNION 5th source not added.** Contract E says UNION
   query gets a `FriendRequest`/`FriendAcceptance` source and the
   `activity-friend-request-source.int.spec.ts` is required in AC.
   No `activity` module touched under `apps/api/src`. Acceptance
   Criteria line will fail a strict reading.

### MED

3. **027 DM block flip not wired.** Design Decisions §"차단 시 기존
   DM 채널은 유지" mandates a `ChannelPermissionOverride` DENY flip on
   block. `direct-messages.service.ts` grep for `Friendship` / `FRIEND_BLOCKED`
   → 0 hits. `createOrGet` will still succeed between blocker/blockee,
   and existing DMs stay writable. Risk section explicitly flags this.

4. **Friend cap is TOCTOU.** `count >= 1000` then `create` runs in two
   statements without a tx or advisory lock; two concurrent requests
   from a user at 999 both pass the guard and land at 1001. Low
   real-world impact but worth either `$transaction` + recount under
   `SERIALIZABLE`, or a Postgres trigger.

5. **P2002 in block-flip tx.** The `$transaction(delete → create)`
   runs under default READ COMMITTED; two concurrent `block(A,B)` and
   `block(B,A)` calls can race the delete step and the second create
   will raise P2002, which is not swallowed (unlike `requestByUsername`).
   Should mirror that try/catch.

### LOW

6. **Mobile tabbar `active` not set on `/friends` route.** Cosmetic;
   You-tab shown as active when user is on /friends. One-liner.

7. **No server-rail "친구" entry point.** Spec explicitly defers to
   F-3, so acceptable, but `/friends` is URL-only today.

8. **Rate-limit 10/min vs summary 5/min.** Code uses
   `max:10` for `fr:req` (matches contract §B) and `max:5` for
   `fr:block`. The handoff summary's "join 5/min" was a transcription
   slip, not a defect.

## Scope Conformance

| Chunk                    | Status                                           |
| ------------------------ | ------------------------------------------------ |
| A DB                     | OK                                               |
| B API                    | OK (minus cap atomicity)                         |
| C Desktop                | OK                                               |
| D Mobile                 | OK (tabbar `active` nit)                         |
| E Notifications+Activity | **MISSING** (outbox events + UNION source)       |
| F E2E                    | Present; integration spec likely shallow given E |
| G Auto-promote           | N/A at review time                               |

## Required before merge

- Implement `friend.request.received` / `friend.request.accepted`
  emit in service methods + wire dispatcher branch on web.
- Add Activity UNION 5th source + int spec.
- Add Friendship lookup to DM `createOrGet` + message send path.
- Wrap cap check in tx; catch P2002 in block-flip.
