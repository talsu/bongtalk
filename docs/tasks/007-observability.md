# Task 007 — Observability & Operations Automation

## Context

Task 005 shipped the realtime layer but we cannot prove its 48h staging
stability without instrumentation. Task 007 adds the metrics + tracing +
alerting surface the runbook assumed, plus a soak harness that turns the
48-hour run into an automatic pass/fail verdict.

No new feature code. Every new code path is a gauge, histogram, span, or
health check layered on top of code we already reviewed.

## Scope (IN)

- **OpenTelemetry SDK** bootstrapped at process start with HTTP/express/pg/
  ioredis/NestJS auto-instrumentation. OTLP HTTP exporter + noop fallback.
  10% sampling by default.
- **Prometheus exposition** (`/metrics`) via `prom-client`. 30 metrics
  across HTTP/DB/Redis/Outbox/Realtime/Domain/Auth. All label enums are
  whitelisted — a cardinality integration test guards against regressions.
- **Trace propagation across the outbox async bridge**: the active
  `traceparent` is captured at `OutboxService.record()` and restored at
  `OutboxDispatcher` emit time, so a single trace id connects the HTTP
  request that wrote the event with the WS emit that delivered it.
- **Deep `/readyz`**: DB + Redis + outbox-dispatcher staleness. Returns
  503 with a specific failing check so the canary pipeline can
  auto-rollback on staleness, not just on uncaught errors.
- **Prometheus alert rules** mirroring `docs/runbook/realtime-soak.md`
  SLOs — `HTTP5xxRateHigh`, `HTTPLatencyP95High`, `WSDisconnectRateHigh`,
  `ReplayTruncationSpike`, `OutboxDispatcherStalled`, `OutboxBacklogGrowing`,
  `OutboxDLQAny`, `DBPoolExhausted`, `PresenceKeyDrift`,
  `AuthSessionCompromisedSpike`.
- **Grafana dashboards** (4): Overview / Realtime / Outbox / DB & Redis,
  committed as JSON with a `${ds}` Prometheus datasource variable.
- **Soak harness** (`evals/soak/`): a pure-tsx runner that exercises
  steady-state + channel-churn + member-churn scenarios against a live
  stack, queries Prometheus at end-of-run, and writes a Markdown verdict
  report. Usable locally (`pnpm soak:local`) and via workflow (48h).

## Scope (OUT) — future tasks

- Logs aggregation pipeline (Loki routing) → TODO(task-019).
- APM UI choice (Tempo vs Jaeger vs commercial) → infra-level, deferred.
- Tail-based sampling policy tuning → TODO(task-020).
- OpenTelemetry data cost monitoring → TODO(task-021).
- Actual 48h staging soak run — this task ships **readiness**, not the run.

## Acceptance Criteria (mechanical)

1. `pnpm verify` exit 0.
2. `pnpm test:int` exit 0 — including `metrics.int`, `tracing.int`,
   `health.degraded.int`, `cardinality.int`.
3. `pnpm test:e2e` exit 0.
4. `.env.example` gains `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
   `OTEL_SAMPLER_RATIO`, `METRICS_ENABLED`, `SOAK_DURATION_MINUTES`.
5. Cardinality test asserts no metric family exceeds 500 series after a
   50-request mixed workload.
6. Health degraded test asserts /readyz flips to 503 within one tick of
   the dispatcher falling behind.
7. Trace test asserts `__trace` is stored on outbox payload and NOT leaked
   to WS subscribers.
8. `evals/tasks/016–018` added, `pnpm eval --dry-run` green.
9. Reviewer subagent spawned; blocker resolution captured.

## Metrics Catalog (summary — full table at `apps/api/src/observability/metrics/metrics.service.ts`)

30 metrics across 7 families. All label values come from pre-declared
enums (`MetricsService.bucket()`); anything unrecognised is bucketed to
`_other` so a runaway caller can't blow up cardinality.

High-signal subset:

- `http_requests_total{method,route,status_class}`, `http_request_duration_seconds{method,route}` (histogram)
- `db_query_duration_seconds{operation,model}`, `db_transaction_duration_seconds`
- `redis_command_duration_seconds{command}`
- `outbox_events_dispatched_total{event_type,result}`, `outbox_event_dispatch_latency_seconds{event_type}`,
  `outbox_pending_events`, `outbox_dlq_events`, `outbox_last_dispatch_timestamp_seconds`
- `ws_connections_active`, `ws_events_emitted_total{event_type}`,
  `ws_replay_events_total{result}`, `ws_message_fanout_latency_seconds`
- `messages_sent_total`, `messages_sent_idempotent_replayed_total`
- `auth_logins_total{result}`, `auth_session_compromised_total`

### Cardinality analysis

Worst-case series estimate (from the PLAN table):

- HTTP: ≤ 1,280 counter + 320 × 10 histogram buckets
- DB: 60 × 10 buckets
- Outbox: 20 × 10 buckets
- Redis: 15 × 10 buckets
- Everything else: ≤ 20 each

Total ceiling is ~3,500 series per instance — well inside Prometheus
comfort zone. Cardinality test uses a stricter per-family gate (< 500) so
a regression that puts `userId` (potentially millions of values) into a
label surfaces immediately.

## Trace Plan

```
POST /messages ──▶ http.server (auto, 10% sampled)
                    ├─ guards.workspace-member (internal)
                    ├─ guards.channel-access (internal)
                    ├─ messages.service.send (internal)
                    │   ├─ pg $transaction (auto)
                    │   └─ redis rate-limit.check (auto)
                    │
                    └─ OutboxEvent.payload.__trace = captureTraceparent()
                                         │
                 OutboxDispatcher.tick ───┤  (minutes later)
                                         │
                    └─ restoreContext(__trace) ──▶ emitAsync('message.created', env)
                                                        ├─ OutboxToWsSubscriber
                                                        │   ├─ ws.emit (manual span)
                                                        │   └─ redis XADD (auto)
                                                        └─ MembershipRevocationListener
```

Forbidden span attributes: `content`, `password`, `token`, `email`,
`authorization`, `cookie`. Enforced at the SDK `requestHook` level for HTTP
headers and by policy in manual span helpers.

## Alerting Rules

`infra/k8s/monitoring/alerts.yaml` — 10 rules. Thresholds match
`docs/runbook/realtime-soak.md` SLOs so soak verdict = alert firing.

## Soak Harness

- `evals/soak/run.ts` — main loop
- `evals/soak/scenarios.ts` — steady-state, channel-churn, member-churn
- `evals/soak/collect-metrics.ts` — Prometheus instant-query client
- `evals/soak/report.ts` — Markdown writer w/ verdict
- `pnpm soak:local` runs a 15-minute local verification. CI workflow for
  the 48h run is intentionally left as a follow-up PR (needs staging infra).

## Non-goals

- Log aggregation / APM UI / tail sampling / cost monitoring (see § Scope OUT).

## Risks

- **prom-client memory** — default metrics include per-process GC + memory
  gauges that can be heavy. Default register kept; if scrape cost spikes we
  trim to domain-only via env.
- **Auto-instrumentation patch timing** — `startOtel()` must run BEFORE the
  first Nest/express import; otherwise `http` is already loaded and the
  monkey-patch silently no-ops. The comment in `main.ts` flags this.
- **OTEL exporter noisiness** — DiagConsoleLogger set to WARN. If the
  OTLP endpoint is misconfigured the SDK will log periodic failures but
  the fail-open bootstrap means API traffic keeps flowing.

## Progress Log

- `planner` — catalog + trace plan + cardinality analysis up front.
- `implementer` — OTEL bootstrap → metrics registry → HTTP interceptor →
  Prisma middleware → ioredis hooks → outbox counters + trace bridge →
  gateway counters + fanout histogram → domain counters → health deepened.
- `tester` — metrics exposition + cardinality + tracing propagation +
  health degraded state.
- `reviewer (subagent)` — see `docs/tasks/007-observability.review.md`.
