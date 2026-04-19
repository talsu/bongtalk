## Summary

Instrumentation-only task. No new user-facing features. Gives the staging
48h soak a defensible pass/fail verdict by making the system explain
itself — metrics, traces, alerts, and a scripted soak harness.

## What ships

- **OpenTelemetry SDK** at the top of `main.ts` (must run before Nest
  imports so auto-instrumentation can monkey-patch). Auto-instruments
  HTTP / express / pg / ioredis / NestJS. 10% sampler default.
  Fail-open: every SDK start error is caught and logged; the app boots
  without traces rather than crashing.
- **Prometheus** at `/metrics`. 30 metrics, every label value coerced
  through a whitelisted enum via `MetricsService.bucket()`. Cardinality
  integration test asserts no family exceeds 500 series under a
  50-request mixed workload.
- **Outbox trace bridge** — `OutboxService.record()` captures
  `traceparent` into `payload.__trace`; `OutboxDispatcher` strips it
  from the wire envelope and restores context around `emitAsync`. One
  trace id now connects HTTP message POST → Outbox row → WS emit on
  another socket.
- **Deep `/readyz`** — DB + Redis + outbox-dispatcher staleness, each
  with a 5s timeout. Returns 503 + `checks.outbox='stalled'` + a
  human-readable `details.outbox` when the dispatcher has been quiet
  more than 10s. Drives CD auto-rollback.
- **Prometheus alert rules** at `infra/k8s/monitoring/alerts.yaml`,
  exactly matching the SLOs in `docs/runbook/realtime-soak.md`.
- **4 Grafana dashboards** (Overview / Realtime / Outbox / DB-Redis) as
  JSON with a `${ds}` datasource variable.
- **Soak harness** at `evals/soak/` — tsx runner, 3 scenarios
  (steady-state, channel-churn, member-churn), Prometheus instant-query
  client, Markdown report writer with pass/fail verdict.
  `pnpm soak:local` for 15-minute local verification; a 48h workflow is
  the consumer of this plumbing (task-019).

## Reviewer

Report at `docs/tasks/007-observability.review.md`.
**changes-requested → approve**. Five BLOCKERs landed on this branch:

1. OTEL requestHook was mutating live request headers (deleted Cookie /
   Authorization before handler chain) → auth silently broke.
   Replaced with `headersToSpanAttributes` allowlist; headers are left
   untouched, tokens never hit spans.
2. Redis instrumentation listened on non-existent events
   (`commandQueued` / `commandExecuted`) → histogram silently no-op.
   Replaced with `sendCommand` funnel wrap + command allowlist.
3. `withTimeout` never cleared the pending `setTimeout` — canary pipeline
   polling /readyz every 30s would leak timers forever.
4. WS disconnect reason was hard-coded to `'client'` regardless of
   transport error; alert selector `{reason="transport_error"}` never
   matched reality. Now uses the actual Socket.IO reason string mapped
   through `normalizeReason()`.
5. Auth metrics (`authLoginsTotal`, `authSessionCompromisedTotal`,
   `authRefreshRotationsTotal`) + `wsPresenceSessionsActive` were
   declared but never written → `AuthSessionCompromisedSpike` alert
   silently dead. Wired on every success / failure / lock branch.

Three metric declarations remain unwired (`dbPoolConnections`,
`redisPoolConnections`, `workspaceMembersActive`) because the
underlying drivers don't expose the pool events we need without
deeper surgery — documented as TODOs in the review doc, their alerts
explicitly marked inactive until task-019.

## Test plan

- [x] `pnpm verify`
- [x] `pnpm --filter @qufox/api test:int` (200/200 pre-fix, observability + auth re-verified after fix)
- [ ] `pnpm test:e2e` (docker, unchanged surface)
- [x] `scripts/check-guard-coverage.ts`
- [ ] Local 15-minute soak run (`pnpm soak:local`)
- [ ] 48h staging soak per `docs/runbook/realtime-soak.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
