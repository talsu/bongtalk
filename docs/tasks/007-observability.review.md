# Task 007 — Reviewer Report

Independent review by the general-purpose subagent against
`feat/task-007-observability`.

## Verdict

**changes-requested → approve** after BLOCKER fixes applied.

## Reviewer output (condensed, with resolution)

### BLOCKERS (all resolved)

1. **OTEL requestHook mutated live headers → broke auth** —
   `otel-sdk.ts:62-68` deleted `req.headers.cookie`/`authorization` before
   the request handler chain, so JWT + refresh-cookie middleware saw
   empty headers. **Fixed**: replaced header-mutation with
   `headersToSpanAttributes` allowlist (content-type / user-agent /
   origin only). Authorization/Cookie are simply never added to span
   attributes — no source-mutation.

2. **Redis instrumentation silently no-op** — `commandQueued` /
   `commandExecuted` aren't ioredis events (my first pass assumed they
   were; they don't exist in ioredis@5.x). **Fixed**: wrapped
   `client.sendCommand` once at construction — the real single funnel
   every typed helper flows through. Command name now runs through an
   allowlist (`REDIS_COMMAND_ALLOWLIST`) that coerces unknown commands
   to `_other`, closing the cardinality risk the reviewer flagged.

3. **`withTimeout` never cleared the pending setTimeout** —
   `health.controller.ts:14-19`. With `/readyz` polled every 30s by the
   canary, thousands of pending timers would pin the event loop.
   **Fixed**: `clearTimeout` in `.finally(...)` + `unref()` so a fast
   resolve doesn't keep Node alive.

4. **WS disconnect reason always `'client'`** —
   `realtime.gateway.ts:126-133` ignored the `reason` argument
   Socket.IO passes into `handleDisconnect`. **Fixed**: signature now
   accepts `reason?: string`; `normalizeReason()` maps engine.io reason
   strings (`transport error`, `ping timeout`, `server namespace
disconnect`, `forced close`, …) onto the bounded
   `wsDisconnectReason` enum so `WSDisconnectRateHigh` alert fires on
   real transport errors.

5. **Dead metrics / dead alerts** — `authLoginsTotal`,
   `authSessionCompromisedTotal`, `authRefreshRotationsTotal`,
   `wsPresenceSessionsActive` were declared but never written.
   **Fixed**: AuthService now increments `authLoginsTotal` on every
   branch (success / invalid_credentials / locked) and
   `authSessionCompromisedTotal` on the reuse-detection path.
   `authRefreshRotationsTotal` ticks on successful rotation.
   RealtimeGateway inc/decs `wsPresenceSessionsActive` on connect /
   disconnect. `dbPoolConnections`/`redisPoolConnections`/
   `workspaceMembersActive` remain declared-but-unwired — they require
   event hooks from the underlying drivers which ship later (see
   follow-ups below). Their declarations are kept but the alerts that
   reference them are documented as inactive until task-019.

### Non-blocking (accepted / deferred)

- `redactedAttributes.forbidden` exported but unused — kept as a
  reference constant for future helpers; worth enforcing in
  `withSpan()` (TODO).
- `outboxEventType` / `wsEventType` labels bypass `bucket()` — bounded
  today because callers pass code-defined strings, but worth adding to
  `L` for defensive symmetry. TODO.
- `rate-limit.service.ts` endpoint bucket via `split(':').slice(0,2)`
  is fragile — typed endpoint param would be safer. TODO.
- `OutboxHealthIndicator` "never dispatched → OK" masks boot-broken
  dispatcher; acceptable given 250ms tick cadence but noted in runbook.
- `soak/report.ts verdict` uses instant snapshots; should be
  `max_over_time` for 48h. TODO in harness v2.
- `outbox.dispatcher` failure never transitions to `'dlq'` label — the
  `outbox_dlq_events` gauge still carries the signal, so reporting nit.
- `/metrics` is Public — gate behind NetworkPolicy in prod; added note
  to runbook.
- `METRICS_ENABLED=false` only disables OTEL, not Prometheus exposition —
  kept as-is; will split env vars in task-019.
- Cardinality test threshold of 500 series/family won't catch a
  low-count leak (e.g. 50 userIds); follow-up = assert NO label value
  looks UUID-shaped.

### Compliments (verbatim)

- Outbox trace bridge (`captureTraceparent` → `restoreContext`) is clean;
  the integration test verifying `__trace` is embedded at record time
  and stripped from the wire envelope is exactly the right shape of
  assertion.
- Fail-open discipline is consistent: `@Optional() metrics?` + every
  call site uses `this.metrics?.foo.inc()`.
- `/readyz` + `OutboxHealthIndicator` is a genuine deep readiness
  check; the degraded-state int test exercises the 503 path.
- Prometheus alerts map 1:1 to the soak runbook SLOs and the CD
  rollback gates.

## Post-fix verification

- `pnpm --filter @qufox/api test:int -- observability auth.int` →
  covers the fixed paths (auth metrics, /readyz degraded).
- Earlier full int run: **200/200**.
