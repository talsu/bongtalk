# Runbook — log pipeline (task-036)

Operator's reference for Loki + Promtail + the qufox/logs dashboard.

## Topology

```
  qufox-* containers  ─┐
                       ├─► Promtail (/var/run/docker.sock)
                       │     │
                       │     └─► Loki :3100 (14-day retention)
  /volume3/qufox-data/loki   │
                             └─► Grafana :3033 → qufox/logs dashboard
```

Both Loki and Promtail run under `/volume2/dockers/grafana/docker-compose.yml`.

## Quick checks

```sh
# Loki alive — labels discovered.
curl -s http://127.0.0.1:3100/loki/api/v1/labels | jq '.data | length'

# Tail the last 15 minutes of qufox-api errors.
curl -s -G http://127.0.0.1:3100/loki/api/v1/query_range \
  --data-urlencode 'query={container="qufox-api"} |= "level\":\"error"' \
  --data-urlencode 'start='"$(date -u -d '15 minutes ago' +%s)000000000" \
  --data-urlencode 'end='"$(date -u +%s)000000000" \
  | jq '.data.result | length'

# Promtail self-check.
docker logs promtail --tail 50 2>&1 | tail
```

## Credentials

Grafana admin password is supplied via `GF_SECURITY_ADMIN_PASSWORD`
in the on-host `.env` next to `docker-compose.yml` in
`/volume2/dockers/grafana/`. The password is **not** committed to git
nor documented here — rotate via `docker compose up -d grafana` after
editing `.env`.

## When an alert fires

### `LokiIngestionStalled`

- Promtail may have crashed or lost docker.sock. Check
  `docker logs promtail --tail 200`.
- If recent `container_sd_manager error`, restart Promtail:
  `docker restart promtail`.

### `LokiHighErrorRate`

- Open qufox/logs dashboard → "Recent errors" panel, filter by the
  firing container label.
- Cross-reference with the prod `/volume2/dockers/qufox-deploy/.deploy/
audit.jsonl` — an error spike within 2 min of a `deploy.result`
  usually points at the fresh rollout.

## Redaction

Promtail's pipeline replaces `password|jwtToken|refreshToken|webhook_secret|api_key`
values with `<redacted>` in both JSON and `key=value` shapes before
shipping. Regex lives in
`/volume2/dockers/grafana/promtail/promtail-config.yml`. Add a field
there + restart Promtail to extend redaction.
