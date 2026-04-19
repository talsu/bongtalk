# Runbook — WebSocket connection debug

**Alert**: WS failure rate > 5% over 5 minutes.

## Symptoms

- Clients see repeated `connect_error`.
- Redis adapter logs ECONNREFUSED or cluster topology changes.

## First 5 minutes

1. `pnpm debug:dump` → inspect `.debug/latest.json` → `redis.reachable`.
2. `kubectl --context=staging logs deploy/qufox-api | grep realtime`.
3. Confirm sticky sessions on ingress (if LB is round-robin, WS upgrades fail).

## Resolution

- If Redis is down → restart ElastiCache node OR scale replica in.
- If ingress rewrote headers → restore Upgrade/Connection headers.
- If pods are OOMing on connection storm → raise HPA ceiling + add rate-limit at gateway.

## Extensions

task-005 will add auto-reconnect with server-side cursor replay. Any fix here
should keep that invariant: no duplicate messages after reconnect.
