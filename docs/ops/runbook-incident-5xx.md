# Runbook — 5xx Spike

Pageable when error rate exceeds 1% over 5 min (post-task-007 alert).

## Step 1: Scope the blast radius (60s)

```sh
# current error rate
curl -sk https://qufox.com/api/metrics | grep 'qufox_http_requests_total{.*status="5' | head
# container status
docker ps --filter name=qufox- --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}'
# api logs — look for the top error message
docker logs qufox-api --tail 200 | grep -iE 'error|panic|unhand' | tail -20
```

If `qufox-api` is in a restart loop or unhealthy, skip to Step 3.

## Step 2: Correlate with recent deploys

```sh
tail -20 /volume2/dockers/qufox/.deploy/audit.jsonl
ls -lht /volume2/dockers/qufox/.deploy/logs/ | head -5
```

If a deploy finished within the last hour: very likely regression.
Jump to `runbook-rollback.md`. Don't diagnose first — roll back, then
diagnose.

If no recent deploy: likely dependency (DB, Redis, external API) or a
traffic spike. Continue Step 3.

## Step 3: Check dependencies

```sh
# db
docker exec qufox-postgres-prod pg_isready -U qufox -d qufox
docker exec qufox-postgres-prod psql -U qufox -d qufox -c \
  'SELECT count(*) FROM pg_stat_activity'
# redis
docker exec qufox-redis-prod redis-cli ping
docker exec qufox-redis-prod redis-cli info memory | grep used_memory_human
# readyz (Nest's own opinion)
curl -sk https://qufox.com/api/readyz | jq .
```

`/readyz` says which subsystem is failing: `db`, `redis`, `outbox`.
Act on whichever returns `fail`.

## Step 4: Known remediations

| Symptom                            | Remediation                                                 |
| ---------------------------------- | ----------------------------------------------------------- |
| `db: fail`, psql also unavailable  | `docker restart qufox-postgres-prod` — wait 30s             |
| `redis: fail`                      | `docker restart qufox-redis-prod` — clears rate buckets too |
| `outbox: stalled`                  | check API logs for dispatch errors; restart qufox-api       |
| qufox-api OOM                      | `docker stats qufox-api` — restart and open issue           |
| Burst traffic, all green otherwise | nothing — monitor, consider rate-limit tuning               |

## Step 5: Escalate

If 5xx > 5% for > 10min after the above, consider emergency restore:

- post-mortem first: `pnpm debug:dump` captures logs + DB + Redis state
  for later.
- then: `scripts/prod-reload.sh` to the previous known-good tag (see
  `runbook-rollback.md`).

## After the incident

- `git commit` an updated runbook if the symptom was new.
- Post-mortem note → `docs/incidents/YYYY-MM-DD-summary.md`.
- Update the alert threshold only if the incident proves it's noisy;
  never to silence a real signal.
