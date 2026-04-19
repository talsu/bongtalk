# PR body — Task 009 (paste into GitHub)

_Written retroactively under task-010-A. The NAS has no `gh` CLI so
this file is the canonical PR text; paste it into the GitHub web
UI when opening PR #15._

**Target**: `feat/task-009-deploy-automation` → `develop`

---

## Summary

- **Webhook CD**: `services/webhook` receives GitHub push events, verifies
  HMAC-SHA256 via timing-safe compare, gates on a branch allowlist,
  coalesces bursts of pushes to the tip SHA, and spawns a deploy. 36
  vitest specs cover HMAC, queue semantics, routing, config, and deploy
  env propagation.
- **Health-checked rollout with rollback**: `scripts/deploy/rollout.sh`
  tags `:latest → :prev` before building, polls `/readyz` (up to 120s)
  after the swap, and auto-invokes `rollback.sh` on health failure. The
  flock is shared with the existing manual `scripts/prod-reload.sh` so
  the two paths never race.
- **Backups + weekly restore test**: `qufox-backup` container (Alpine +
  busybox crond) runs `pg_dump --format=custom` daily + Sunday weekly
  copy + Redis `BGSAVE` snapshot, with FIFO rotation. `restore-test.sh`
  spins an ephemeral `postgres:16-alpine`, `pg_restore`s the newest
  dump, and asserts `COUNT(*) FROM "User"` > 0 — an untested backup is
  no backup.
- **Gitleaks**: `.gitleaks.toml` + `security.yml` CI workflow + opt-in
  lint-staged hook (no-op if `gitleaks` isn't on PATH).
- **7 runbooks** under `docs/ops/` covering normal deploy, rollback,
  backup/restore, 5xx triage, webhook debug, secret rotation, and the
  nginx diff the operator applies once at switchover.

Scope deliberately avoids touching `nginx.conf`, TLS, DNS, or data
volumes. `scripts/prod-reload.sh` is preserved as an escape hatch.

## Key design decisions

- **Separate compose file** (`compose.deploy.yml`) rather than merging
  into `docker-compose.prod.yml` — a webhook crash can never look like
  an app outage.
- **Local image registry** with `:prev` + `:sha-<short>` tags rather
  than GHCR push/pull — single-node NAS doesn't benefit from registry
  roundtrips, and `:sha` history is capped via `IMAGE_HISTORY_KEEP`.
- **Single-slot coalescing queue** — guarantees the tip SHA builds, but
  doesn't burn CPU rebuilding every intermediate commit during a burst.
- **DB migrations run in-flight** — `prisma migrate deploy` is always
  executed; failures abort before any container is swapped, so the
  previous images keep serving.
- **Zero-downtime is NOT a goal of this task** — blue-green behind
  nginx upstream switching is deferred to a later task.

## Test plan

- [x] `pnpm verify` — 19/19 turbo tasks green (lint + typecheck + test
      across all workspaces incl. `@qufox/webhook`)
- [x] `pnpm --filter @qufox/webhook test` — 36/36 vitest specs pass
      (hmac 9, queue 5, server 12, config 6, deploy 4)
- [x] `bash -n` on every `scripts/deploy/*.sh` + `scripts/backup/*.sh` + `services/backup/entrypoint.sh`
- [x] `docker compose --env-file .env.prod --env-file .env.deploy.example -f compose.deploy.yml config`
      validates
- [ ] switchover day (per `docs/ops/deploy-inventory.md § What stays
    manual`): apply nginx diff → `nginx -s reload` → GitHub webhook
      config → redeliver ping → verify 200
- [ ] first end-to-end auto-deploy (no-op README PR merged to main)
- [ ] first backup + first weekly restore-test green in Slack

## Commit sequence

```
a03bebd docs(deploy): inventory existing prod-reload.sh + env layout
16c53a1 feat(deploy): webhook server with HMAC + queue + branch allowlist
83e1546 feat(deploy): auto-deploy + rollout + rollback + health-wait + lock scripts
c07551c feat(deploy): backup + restore-test + cron container
25493df feat(deploy): compose.deploy.yml wiring webhook + backup-cron
768024e test(deploy): webhook HMAC/queue/server/config + script syntax harness
1770371 docs(deploy): 7 runbooks (deploy, rollback, backup, 5xx, webhook, secrets, nginx diff)
b1284f6 chore(deploy): gitleaks config + CI + opt-in pre-commit hook
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
