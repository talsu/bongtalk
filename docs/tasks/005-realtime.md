# Task 005 — Realtime WS: Outbox Fan-out / JWT Handshake / Presence / Multi-node

## Context

Tasks 001-004 already produce durable, uniquely-id'd outbox events for every
state change. Task 005 is the projection layer — we don't invent new domain
surface, we route the envelope you already have onto Socket.IO rooms keyed
by the aggregate it mutated. The correctness bar is distributed-systems
correctness (cross-node delivery, reconnect replay, membership revocation)
rather than new endpoints.

Inherits:

- Outbox envelope `{ id, type, occurredAt, workspaceId, channelId?, actorId, ... }` (task-003/004)
- `OutboxDispatcher.EventEmitter2.emitAsync(type, envelope)` as the single
  server-side fan-out seam — so the projection subscriber is just
  `@OnEvent('message.*')`, nothing more.
- JWT access tokens (task-001) — same verification path as HTTP routes.

## Scope (IN)

- **JWT handshake middleware** (auth via `auth.accessToken`, reject on
  expiry/tamper with connect_error).
- **Auto room join**: `workspace:{id}`, `channel:{id}`, `user:{id}` — one
  DB round-trip at connect, no N+1.
- **Outbox→WS projection**: `@OnEvent` subscriber maps event type → room.
- **Replay buffer**: per-channel Redis Stream, `MAXLEN~1000`, XADD on emit,
  XRANGE on reconnect from `x-last-event-id`. Truncation fallback via
  `replay.truncated` event.
- **Presence**: session-keyed Redis hash, 120s TTL rolled by heartbeat,
  workspace-level online-user SET, 2s throttled `presence.updated`
  broadcast.
- **Membership revocation live-kick**: listener on `workspace.member.left`
  fetches the target user's sockets across all nodes (adapter) and
  disconnects them.
- **Redis pub/sub adapter** (`@socket.io/redis-adapter`) wired in
  `RedisIoAdapter` so N instances share the room graph.
- **Frontend**: `useRealtimeConnection` (singleton socket, heartbeat,
  lastEventId tracking), `useLiveMessages` (React Query cache merge with
  id-based dedupe), `usePresence` (workspace online SET).
- **Multi-node correctness**: integration test spawns two
  NestApplications against the same PG+Redis and asserts cross-node fan-out.

## Scope (OUT) — future tasks

- VOICE / video / screen-share SFU → TODO(task-028).
- Typing indicator → TODO(task-029). (Excluded from 005 by design — keeps
  scope finite.)
- Unread-count UI (the read-state row is written, the UI isn't) → TODO(task-027).
- Push notifications for offline users → TODO(task-030).
- Private-channel ACL → TODO(task-016) — task-005's room-manager already
  skips `isPrivate=true` channels.
- Full schema-per-worker E2E isolation → TODO(task-018). This task enables
  Playwright `workers:4 + fullyParallel:true` which already gives the full
  wall-time win; real per-worker NestApplication instances are the next
  step when we hit a global-Redis-key contention.

## Acceptance Criteria (mechanical)

1. `pnpm verify` exit 0.
2. `pnpm --filter @qufox/api test:int` — including `ws.handshake`,
   `ws.message-fanout`, `ws.reconnect-replay`, `ws.multi-node`,
   `ws.membership-revocation`.
3. E2E in Docker (Playwright `workers:4`).
4. Migration `add_user_channel_read_state` reversible (`DROP TABLE`).
5. `.env.example` gains `WS_REPLAY_BUFFER_SIZE`, `PRESENCE_SESSION_TTL_SEC`,
   `PRESENCE_UPDATE_THROTTLE_MS`, `WS_HEARTBEAT_INTERVAL_MS`.
6. `evals/tasks/013-015` added, `pnpm eval --dry-run` green.
7. Reviewer subagent spawned (report in `docs/tasks/005-realtime.review.md`).
8. Staging soak runbook in `docs/runbook/realtime-soak.md`.

## Prerequisite outcomes

- **Cleanup-1 (E2E parallelization)**: Playwright now runs `workers: 4` with
  `fullyParallel: true`. Each test already creates data keyed by
  `Date.now()+random`, so workspace/user/channel conflicts are impossible in
  practice — the simpler approach (no schema per worker) wins this round.
  Full NestApplication-per-worker is TODO(task-018).
- **Cleanup-2 (Redis adapter)**: wired `@socket.io/redis-adapter` (pub/sub)
  via a custom `RedisIoAdapter` that takes duplicated `ioredis` connections
  from the existing pool. Chose pub/sub over streams because the outbox
  itself is our durable source-of-truth and the per-channel replay stream
  covers subscriber-downtime recovery — adapter-layer durability would
  double-protect against the same failure at extra ops cost.

## Design Decisions

### Sequence — send → outbox → dispatcher → WS fan-out

```
[A] POST /messages ─▶ MessagesService.$transaction
                        ├─ message row committed
                        └─ OutboxEvent row committed (same commit)
                           │
                           ▼  (poll 250ms, SKIP LOCKED)
                    OutboxDispatcher claims batch
                           │
                           ▼
                    EventEmitter2.emitAsync('message.created', envelope)
                           │
         ┌─────────────────┴─────────────────────┐
         ▼                                       ▼
  OutboxToWsSubscriber                    MembershipRevocationListener
    @OnEvent('message.*')                   @OnEvent('workspace.member.left')
         │                                       │
    ReplayBuffer.append('channel', chId, env)    presence.forceKickSessions
         │                                       │
    io.to('channel:'+chId).emit(type, envelope)  gateway.kickUserEverywhere
         │
    ╭────┴──────────────────────────────╮
    ▼ (Redis pub/sub adapter)           ▼
  node-1 sockets                    node-2 sockets
    │                                   │
    ▼                                   ▼
[A]                                   [B]  ← browser receives
```

### Room naming

| Room             | Audience                              | Events                                                                               |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| `workspace:{id}` | every connected member                | `channel.created/deleted`, `workspace.member.*`, `presence.updated`, `channel.moved` |
| `channel:{id}`   | every connected member (no ACL today) | `message.*`, `channel.updated/archived/unarchived`                                   |
| `user:{id}`      | only that user's sockets              | per-user events (kick, role change)                                                  |

### Event contract (server → client)

| Event                                       | Origin                | Room                               | Payload shape                                             |
| ------------------------------------------- | --------------------- | ---------------------------------- | --------------------------------------------------------- |
| `message.created`                           | outbox                | `channel:{id}`                     | task-004 `MessageCreatedPayload` + `{id,type,occurredAt}` |
| `message.updated`                           | outbox                | `channel:{id}`                     | `MessageUpdatedPayload` + envelope                        |
| `message.deleted`                           | outbox                | `channel:{id}`                     | `MessageDeletedPayload` + envelope                        |
| `channel.created`                           | outbox                | `workspace:{id}`                   | task-003 channel envelope                                 |
| `channel.updated/archived/unarchived/moved` | outbox                | `channel:{id}` + `workspace:{id}`  | channel envelope                                          |
| `channel.deleted`                           | outbox                | `workspace:{id}`                   | channel envelope                                          |
| `workspace.member.joined/left/role_changed` | outbox                | `workspace:{id}` + `user:{target}` | member envelope                                           |
| `presence.updated`                          | throttler (2s)        | `workspace:{id}`                   | `{ workspaceId, onlineUserIds: string[] }`                |
| `replay.complete`                           | gateway               | single socket                      | `{ replayed: number }`                                    |
| `replay.truncated`                          | gateway               | single socket                      | `{ lastEventId: string }`                                 |
| `connection.error`                          | gateway (before kick) | single socket                      | `{ code }`                                                |

### JWT handshake timing

Client passes `accessToken` via `io(url, { auth: { accessToken } })`. The
WsAuthMiddleware verifies before `connection` fires — on failure the socket
never enters the connected pool, client sees `connect_error`. Token
expiration mid-connection is handled by the client: on the next HTTP call
that returns 401 (not on the WS itself), the HTTP layer refreshes the
access token, then the socket is `disconnect()` + `connect()` with the
fresh token. **We deliberately do not implement in-WS refresh** — simpler
to fold into the existing HTTP refresh flow, and a WS reconnect is cheap.

### Replay strategy

Per-channel Redis Stream `replay:channel:{chId}` bounded by `MAXLEN~1000`.
`~` = approximate trim (a few hundred over the bound) — cheaper than exact.
On reconnect the server XRANGEs the whole stream and slices after the
client's `lastEventId`. Worst case = 1000 linear comparisons, O(a few
hundred μs) against local Redis. When `lastEventId` isn't found, we emit
`replay.truncated` and the client issues REST `/messages?after=` against
the cursor API from task-004 — the DB is still the authoritative store.

Memory estimate: ~1KB per envelope × 1000 × channels. 10k channels ≈
10MB — fits. If a workspace explodes past that we add a per-workspace
LRU (TODO(task-030) monitoring first).

### Presence

Session-based because one user can have N tabs. Each WS connection
registers a HASH keyed by `sessionId`, SADDs into `presence:workspace:{wsId}:users`,
and TTLs at 120s rolled by `presence:ping` every 15s. Last session gone →
SREM from the workspace set → throttled broadcast.

### Channel routing for `channel.created`

New channels aren't in any current socket's room list. Routing via
`workspace:{id}` solves this — every member gets the event, the client
re-fetches the channel list, and new message events for the new channel
will automatically reach the socket once the client's component re-mounts
with the new channelId filter.

## Non-goals

- Typing indicators, voice, per-channel ACLs, push notifications (see
  § Scope OUT).

## Risks

- **Dispatcher at-least-once → client sees dup**: mitigated by
  `envelope.id` dedupe in both server replay and web store. Integration
  test `ws.message-fanout` asserts client can collapse two identical ids
  to one logical event.
- **Session TTL leak**: if a node crashes without running disconnect
  hooks, the workspace SET will hold stale user ids until the 120s TTL
  expires AND the user re-visits (triggers `onlineIn` lazy GC). Acceptable
  for MVP; monitoring is on the runbook.
- **Kick-then-event ordering**: MembershipRevocationListener defers the
  disconnect by 50ms to let the already-emitted `workspace.member.left`
  reach the wire. Any new events arriving after the kick don't reach the
  evicted socket — verified by `ws.membership-revocation` spec's
  "after kick" assertion.

## Progress Log

- `planner` — plan + sequence + adapter A/B + replay A/B/C emitted; user
  picked (A pub/sub + A per-channel stream + exclude typing).
- `implementer` — cleanup-1 and cleanup-2 first (parallelization + Redis
  adapter), then ws-auth → room-manager → presence → replay buffer →
  projection subscribers → gateway → revocation listener → web hooks.
- `tester` — 5 integration specs (handshake / fan-out / replay /
  multi-node / revocation). Multi-node spec spawns a second NestApp via
  the `spawnSecondInstance` factory on the shared PG+Redis.
- `reviewer (subagent)` — see `docs/tasks/005-realtime.review.md`.
