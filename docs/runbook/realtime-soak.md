# Runbook — Realtime WS Staging Soak

The realtime layer (task-005) lands behind the outbox — correctness of the
HTTP + DB path doesn't vouch for WS stability. Before promoting to prod,
run a **48-hour continuous soak** on staging against production-shaped
traffic (synthetic OK: cURL + `socket.io-client` loop).

## Metrics to watch (Grafana, `realtime/*` dashboard)

| Metric                                                         | SLO                                                | Alert threshold                                                 |
| -------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| WS connection count                                            | tracks DAU trend                                   | ±3σ vs last week                                                |
| WS disconnect rate (per 5m window)                             | < 2% of active                                     | > 5%                                                            |
| Replay latency (handshake → `replay.complete`)                 | p95 < 500 ms                                       | p95 > 2 s                                                       |
| `replay.truncated` rate                                        | < 0.1% of reconnects                               | > 1% — bump `WS_REPLAY_BUFFER_SIZE` or add per-workspace stream |
| Outbox → WS emit lag (dispatcher tick → first socket receives) | p95 < 300 ms                                       | p95 > 1 s — profile dispatcher + Redis pub/sub hop              |
| Redis memory — `qufox:replay:*`                                | per-channel × 1 KB × 1000 ≤ 10 MB for 10k channels | > 50 MB — tighten MAXLEN or shard Redis                         |
| Redis key count — `qufox:presence:session:*`                   | ≤ active WS connections × 1.1                      | > 2× connections — heartbeat broken, investigate                |
| Outbox dispatchedAt lag (oldest undispatched row age)          | < 500 ms                                           | > 5 s                                                           |

## Commands

```bash
# Live WS connection count (all nodes):
redis-cli --scan --pattern 'qufox:presence:session:*' | wc -l

# Channel replay backlog (top 10 by length):
redis-cli --scan --pattern 'qufox:replay:channel:*' | xargs -I{} redis-cli XLEN {} | sort -rn | head

# Undispatched outbox rows (should drain within seconds):
psql "$DATABASE_URL" -c 'SELECT count(*), min("occurredAt") FROM "OutboxEvent" WHERE "dispatchedAt" IS NULL'

# Stuck retries:
psql "$DATABASE_URL" -c 'SELECT id, "eventType", attempts, "lastError" FROM "OutboxEvent" WHERE attempts > 3 ORDER BY "occurredAt" DESC LIMIT 20'
```

## Failure modes to watch for

1. **Socket adapter lockup** — Redis pub/sub subscriber connection dies
   silently. Symptom: cross-node tests fail but same-node works.
   Mitigation: `RedisIoAdapter.connectToRedis` throws on `error`; restart
   the node. Long-term: swap to `redis-streams-adapter` (evaluated, deferred).
2. **Presence SET grows without bound** — lazy GC only runs on
   `onlineIn()`. If a workspace becomes inactive, stale user ids sit for
   up to 120s × N. Monitor `qufox:presence:workspace:*:users` SCARDs.
3. **Kick-before-event race** — if the 50ms defer between event emit and
   socket disconnect gets tuned down too aggressively, `workspace.member.left`
   may not reach the kicked user. Integration test `ws.membership-revocation`
   is the guard.
4. **Replay buffer truncation under steady load** — if a single channel
   produces > 1000 events while a client is offline, reconnect falls back
   to REST. Not a bug, but high `replay.truncated` rate → bump MAXLEN.

## Go/no-go for prod

- 48h wall-clock with SLOs continuously met.
- At least one forced node restart during the soak → cross-node fan-out
  keeps working, no event loss (verified by a synthetic "post every 10s,
  assert every WS receives it" probe).
- `gh pr create --draft` with the dashboard snapshot + outbox lag graph
  attached.
