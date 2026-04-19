# Runbook — Secret rotation

## What lives where

| Secret                  | File                                                        | Consumed by                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`     | `.env.prod`                                                 | qufox-api, qufox-postgres-prod, qufox-backup, **qufox-webhook** (for `docker compose run qufox-api pnpm db:migrate` inside auto-deploy.sh — passed in via `env_file: [.env.prod]` in compose.deploy.yml) |
| `JWT_ACCESS_SECRET`     | `.env.prod`                                                 | qufox-api                                                                                                                                                                                                |
| `GITHUB_WEBHOOK_SECRET` | `.env.deploy`                                               | qufox-webhook + GitHub webhook config                                                                                                                                                                    |
| `SLACK_WEBHOOK_URL`     | `.env.deploy`                                               | qufox-webhook (optional)                                                                                                                                                                                 |
| GitHub deploy-key       | `${WEBHOOK_SSH_DIR}` (default `/volume1/secrets/qufox-ssh`) | qufox-webhook `git fetch origin` — bind-mounted read-only at `/root/.ssh`; pubkey must be added to the repo's Deploy Keys                                                                                |

Both files live at the repo root on the NAS, `0600 admin:users`,
git-ignored. The `*.example` siblings are tracked in git and must
never hold real values (gitleaks CI blocks accidental commits).

## Rotating `GITHUB_WEBHOOK_SECRET`

Zero app-downtime; only the webhook receiver restarts.

```sh
# 1. new value
NEW=$(openssl rand -hex 32)
# 2. stash in GitHub first (Settings → Webhooks → qufox → Secret)
# 3. update .env.deploy
sed -i "s|^GITHUB_WEBHOOK_SECRET=.*|GITHUB_WEBHOOK_SECRET=$NEW|" \
  /volume2/dockers/qufox/.env.deploy
# 4. restart the receiver
cd /volume2/dockers/qufox
docker compose --env-file .env.deploy -f compose.deploy.yml up -d --no-deps qufox-webhook
# 5. GitHub → Recent Deliveries → Redeliver a ping, expect 200
```

Mismatch window: if you update GitHub before the NAS, pushes during
the gap return 401; GitHub retries, so no push is lost.

## Rotating `JWT_ACCESS_SECRET`

⚠ Invalidates every access token in the wild — every logged-in user
refreshes on the next call. Refresh tokens are unaffected (they're
Argon2-hashed in Postgres, not JWT).

```sh
NEW=$(openssl rand -hex 64)
sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$NEW|" \
  /volume2/dockers/qufox/.env.prod
scripts/prod-reload.sh api    # manual restart picks up new env
```

Tokens minted with the old secret become invalid immediately. The
frontend's silent-refresh flow handles this transparently — the
practical UX is "one 401 + one refresh" per active user.

## Rotating `POSTGRES_PASSWORD`

⚠ Destructive — coordinate. Every connection drops when the password
changes.

```sh
# 1. stop API to stop new connections
docker stop qufox-api

# 2. change the password inside postgres
NEW=$(openssl rand -hex 32)
docker exec -it qufox-postgres-prod psql -U qufox -d qufox \
  -c "ALTER USER qufox WITH PASSWORD '$NEW';"

# 3. update BOTH .env.prod and .env.deploy (backup service also uses it)
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$NEW|" .env.prod
# .env.deploy references the same var via docker-compose env interpolation

# 4. restart the app stack (DB container stays up; it already has the
#    new password in its own internal storage)
scripts/prod-reload.sh all
docker compose --env-file .env.deploy -f compose.deploy.yml up -d --no-deps qufox-backup
```

Verify: `docker logs qufox-api --tail 20` — no "password authentication
failed" messages; `docker exec qufox-backup /app/scripts/backup/db-backup.sh`
produces a fresh dump.

## If a secret leaks

Assume the adversary already has it. Rotate **before** disclosing.

1. Generate a new value immediately.
2. Update live systems (steps above).
3. Rotate the `JWT_ACCESS_SECRET` too if the attacker might have
   issued tokens — one extra rotation is cheap.
4. Git-log grep (`git log -p | grep <value-fragment>`) to confirm the
   bad secret didn't land in a public commit.
5. If it did: BFG / `git filter-repo` on the history, force-push.
   `main` has branch protection, so this is a deliberate act with the
   team in-the-loop.
6. Post-mortem in `docs/incidents/`.
