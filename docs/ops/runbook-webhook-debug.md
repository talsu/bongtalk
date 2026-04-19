# Runbook — Webhook didn't fire

"I pushed to main but nothing happened."

## Quick checklist

1. GitHub actually sent it — **Repository → Settings → Webhooks →
   Recent Deliveries**. You'll see the exact request + response.
2. Response was 2xx — the webhook got it and ACK'd.
3. `qufox-webhook` is running — `docker ps --filter name=qufox-webhook`.
4. Audit log has the entry:
   `docker exec qufox-webhook tail /repo/.deploy/audit.jsonl`.

Most common failure modes, in order of frequency:

## Signature mismatch (401 in audit `request.reject reason=signature`)

The `GITHUB_WEBHOOK_SECRET` in `.env.deploy` does not match the secret
set in the GitHub webhook config.

```sh
# 1. generate a new secret
openssl rand -hex 32
# 2. update .env.deploy on the NAS (0600 admin:users)
# 3. paste the same value into GitHub Settings → Webhooks → Edit
# 4. restart the receiver
docker compose --env-file .env.deploy -f compose.deploy.yml up -d --no-deps qufox-webhook
# 5. click "Redeliver" on the last ping in GitHub — expect 200 pong
```

## Branch not in allowlist (200 audit `request.ignore reason=branch`)

This is not a bug — develop / feature branches don't trigger prod.
Confirm with:

```sh
grep DEPLOY_BRANCH_ALLOWLIST .env.deploy
```

To promote a branch to auto-deploy, add it comma-separated and restart
the receiver.

## Webhook container is down

```sh
docker ps -a --filter name=qufox-webhook
docker logs qufox-webhook --tail 100
```

Rebuild + restart:

```sh
cd /volume2/dockers/qufox
docker compose --env-file .env.deploy -f compose.deploy.yml build qufox-webhook
docker compose --env-file .env.deploy -f compose.deploy.yml up -d qufox-webhook
```

## Nginx not routing `deploy.qufox.com`

```sh
curl -sk -o /dev/null -w '%{http_code}\n' https://deploy.qufox.com/healthz
```

Expected: `200`. Anything else → nginx config missing the block (see
`runbook-nginx-diff.md`) or cert not issued for the new hostname.

## Deploy ran but failed (202 but no success in slack)

Check the live log:

```sh
ls -lht /volume2/dockers/qufox/.deploy/logs/ | head -5
tail -100 /volume2/dockers/qufox/.deploy/logs/deploy-*.log
```

The script writes each phase (`[auto-deploy]`, `[rollout:api]`,
`[health-wait]`) with a timestamped context. The first `FAIL` line
tells you which stage broke.

## Force-redeploy without a new commit

GitHub webhook → **Recent Deliveries → Redeliver** on any past
successful delivery. The webhook will coalesce into the existing
deploy if one is active, or start a fresh deploy of that same SHA
if idle.

Or from the NAS:

```sh
cd /volume2/dockers/qufox
git fetch origin main
DEPLOY_SHA=$(git rev-parse origin/main) \
DEPLOY_BRANCH=main DEPLOY_PUSHER=manual \
  bash scripts/deploy/auto-deploy.sh
```
