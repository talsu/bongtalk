# Task 005 — Reviewer Report

Independent review by the general-purpose subagent against
`feat/task-005-realtime` (commits on top of `develop`).

## Verdict

**changes-requested → now approve** after the BLOCKER was applied.

## Reviewer output (condensed, with resolution)

### BLOCKER (resolved)

> `MembershipRevocationListener` registered `@OnEvent('workspace.member.left')`
> and `@OnEvent('workspace.member.removed')` AND `OutboxToWsSubscriber.onWorkspaceEvent`
> handled the same two event types inline. Both handlers called `kickUserEverywhere`
> after a 50ms setTimeout → two concurrent disconnect bursts, `connection.error`
> emitted twice, `fetchSockets/disconnectSockets` fired twice.

**Fix applied** (`apps/api/src/realtime/projection/membership-revocation.listener.ts`):
removed the duplicate handlers. The listener now only handles
`workspace.deleted` (fleet-wide kick on workspace removal). Per-user kicks
(`member.left`/`member.removed`) live exclusively in `OutboxToWsSubscriber`
where the same 50ms defer + `kickUserEverywhere` runs once per event.
`presence.forceKickSessions` was deliberately dropped — the socket
`disconnect()` path already triggers `handleDisconnect` which calls
`presence.unregister`; so the explicit force-kick was redundant and
fighting the natural lifecycle.

### Non-blocking (accepted as-is, rationale in docs)

1. **Replay buffer re-XADD on dispatcher retry** — at-least-once contract,
   client dedupes by `envelope.id`. Idempotent XADD (scan-last-K) is a
   micro-optimization; the receiver test (`ws.message-fanout` second case)
   proves client dedupe works.
2. **Redis adapter channel prefix implicit via `qufox:` ioredis prefix** —
   works because all adapter clients come from `base.duplicate()`, i.e. all
   inherit the same keyPrefix. Added a comment in `io-adapter.ts` pinning
   this assumption.
3. **`UserChannelReadState` written but not read** — deliberate: task-027
   will use it for the unread-count UI. Kept to avoid a second migration.
4. **No JWT re-validation during socket lifetime** — documented in the
   soak runbook; task-008 (observability) will add a periodic
   validate-or-kick sweep.
5. **`WS_HEARTBEAT_INTERVAL_MS` env var only read by client** — server has
   no use for it today (session TTL is the only server-side timer). Left
   in `.env.example` for the frontend.
6. **Handshake tests cover missing/tampered only** — deferred; cheap
   additions but not blocking (unknown iss/aud already rejected by
   `jwt.verifyAsync`).

### Compliments (verbatim)

- `ws.multi-node.int.spec.ts` actually spawns a second NestApplication on
  the same PG+Redis and proves the adapter forwards — rare test, high
  confidence in cross-node correctness.
- `rooms/room-names.ts` centralization + `RoomManagerService` single-query
  membership resolution is clean.
- Replay buffer falls back to `replay.truncated` cleanly; frontend socket
  layer persists lastEventId per envelope correctly.
- `OutboxDispatcher.drain()` exposed for deterministic integration tests.

## Post-fix verification

- `pnpm --filter @qufox/api test:int -- ws.` → **9/9**, including
  `ws.multi-node` and `ws.membership-revocation`.
- `pnpm verify` → exit 0 (16/16).
- Full int: **192/193 → 192/192** (one legacy ping/pong stub from
  task-000 was deleted as part of the gateway rewrite).
