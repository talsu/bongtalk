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

## Nginx not routing `/hooks/github`

```sh
# Task-016 ops moved the webhook from `deploy.qufox.com` subdomain
# onto qufox.com apex as a `/hooks/github` location.
curl -sk -o /dev/null -w '%{http_code}\n' -X POST https://qufox.com/hooks/github
```

Expected: `401` (HMAC gate active; nginx reached the webhook).
Anything else — especially `502` or `404` — means the location is
missing from the qufox.com server block. Re-emit with
`scripts/setup/apply-nginx-diff.sh --webhook` and paste inside the
existing server block, then `nginx -t && nginx -s reload`.

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

## Worktree layout (task-017-B)

`qufox-webhook` bind-mounts a **dedicated git worktree** at
`/volume2/dockers/qufox-deploy`, NOT the operator's working tree at
`/volume2/dockers/qufox`. Shared objects + refs via `.git/worktrees/`,
independent HEAD + index.

**Why:** before 017, `auto-deploy.sh` ran `git checkout --force <sha>`
inside the operator's tree → every deploy put `/volume2/dockers/qufox`
into detached HEAD and the operator ran `git checkout main` to
recover. Worktree isolation makes the webhook self-contained.

**One-shot migration (operator, on the NAS):**

```sh
cd /volume2/dockers/qufox
bash scripts/setup/migrate-webhook-worktree.sh --dry-run   # preview
bash scripts/setup/migrate-webhook-worktree.sh             # apply
```

Idempotent — rerunning on an already-migrated install is a no-op.

**Verify:**

```sh
git -C /volume2/dockers/qufox          branch --show-current   # → main (operator)
git -C /volume2/dockers/qufox-deploy   branch --show-current   # → main (or detached <sha> right after a deploy)
docker exec qufox-webhook sh -c 'cd /repo && git rev-parse --abbrev-ref HEAD'  # → main
```

**What if the worktree directory is deleted?** Re-run the migrate
script; it recreates the worktree and recreates the webhook
container. No data loss — the worktree holds only checked-out
files, never state.

**What if the operator needs `main` in BOTH trees at the same
commit?** Fine — git allows two worktrees on the same branch if
you use `git worktree add --detach` + manual checkout. In practice,
the operator works on feature branches in `/volume2/dockers/qufox`
and lets webhook-`main` run loose in `/qufox-deploy`; the two rarely
collide.

**If `/volume2/dockers/qufox` is moved or renamed later**, the
`/qufox-deploy/.git` pointer file breaks. Run `git worktree repair`
from the new main-repo path to refresh the link.
