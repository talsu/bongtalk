# Task 009 — Deployment Automation

_Retroactive task doc. Written after the fact (during task-010) from the
actually-merged commits on `feat/task-009-deploy-automation` (PR #15,
squash-merged to `develop` at `c34f489`). The original task was
executed directly from the user's kickoff message without a
`docs/tasks/` entry — this file closes that process gap for
traceability and review, and is the template future tasks should
follow._

## Context

Production deploy was manual-only: `scripts/prod-reload.sh` shelled
into the NAS, ran `docker compose build + up -d`, slept 3 seconds, and
curl'd `/api/healthz`. The sleep was shorter than typical Nest boot,
reporting FAIL while the container was still initialising. No rollback
ever existed — `qufox/api:latest` was clobbered on every build, so a
bad deploy meant rebuild-from-git to recover. No backups had been taken
since the workspace was seeded. No audit, no concurrency lock, no
HMAC-gated remote trigger.

The app at qufox.com was already serving real users, so the task had
two hard constraints on top of the build-out:

1. **Zero nginx / TLS / DNS / data-volume changes** — every other
   service on the NAS (nginx-proxy-1, certbot, Synology volumes) had
   to remain untouched.
2. **Manual path must continue to work** — `scripts/prod-reload.sh`
   stays as an escape hatch that acquires the same flock, so an
   operator can always bypass the automation.

## Scope (IN)

### A. Webhook CD

- GitHub webhook receiver with HMAC-SHA256 timing-safe compare
- Branch allowlist (env-driven, CSV)
- Single-slot coalescing queue: one deploy active, one pending (latest
  wins)
- Audit log at `.deploy/audit.jsonl`
- Optional Slack notifier (empty env = silent, not a hard error)

### B. Health-checked rollout with auto-rollback

- `rollout.sh` tags `:latest` → `:prev` before building, tags the new
  build as `:sha-<7char>` + `:latest`
- `health-wait.sh` polls `/readyz` for up to 120s after swap
- On health fail, `rollback.sh` re-tags `:prev` → `:latest` and
  recreates the container
- `flock(9)` mutex shared with `scripts/prod-reload.sh`

### C. Backups + weekly restore test

- `qufox-backup` container (Alpine + busybox crond)
- Daily `pg_dump --format=custom` with atomic rename and FIFO rotation
  (daily 14, weekly 8 on Sundays)
- Daily Redis BGSAVE + gzip snapshot
- Weekly `restore-test.sh` spins ephemeral `postgres:16-alpine`,
  `pg_restore`s, asserts `COUNT(*) FROM "User"` > 0 — untested backup
  is no backup
- Backups land on `/volume1/backups/qufox` (different volume from the
  containers on `/volume2`)

### D. Compose + secret management

- Separate `compose.deploy.yml` so webhook / backup container churn
  never looks like an app outage
- `.env.deploy` separate from `.env.prod` — rotating the webhook
  secret doesn't force an app-env edit
- Gitleaks CI workflow + opt-in lint-staged hook

### E. Runbooks

- Seven runbooks under `docs/ops/` covering normal deploy, rollback,
  backup/restore, 5xx triage, webhook debug, secret rotation, and the
  nginx server-block diff the operator applies at switchover.

## Scope (OUT) — not attempted here

- Blue-green or zero-downtime rollout — deferred. Single-node NAS +
  nginx-by-container-name makes proper upstream swap a larger change.
  Current swap window is ~10-30s (container recreate) and documented.
- Image registry push / pull — repo builds locally on the NAS. Adding
  GHCR push was rejected as net-negative round-trip cost for a
  single-node target. `:sha-*` tags give the history needed for
  rollback.
- Destructive DB migrations in the auto path — migrations run, but the
  convention is "additive-only in auto; destructive requires human
  approval and a checkpoint backup." Runbook documents the manual
  workflow.
- Any changes to `/volume2/dockers/nginx/nginx.conf` — operator
  applies the diff in `docs/ops/runbook-nginx-diff.md` once at
  switchover.
- Secret manager integration (sops / Vault / AWS SM) — `.env.deploy`
  at 0600 on the NAS is the MVP. Separate ops task.

## Acceptance Criteria (mechanical)

- [x] `pnpm verify` green (19/19 turbo tasks at branch tip)
- [x] `pnpm --filter @qufox/webhook test` — 36/36 specs pass
      (hmac 9, queue 5, server 12, config 6, deploy 4)
- [x] Every shell script parses under `bash -n`
- [x] `docker compose -f compose.deploy.yml config` validates
- [x] Every artefact referenced in the runbooks exists on disk
- [x] `.env.prod` / `.env.deploy` pattern documented in
      `deploy-inventory.md` and visible in the example files
- [x] Files exist:
  - `services/webhook/src/{config,hmac,queue,audit,deploy,notify,server,main}.ts`
  - `services/webhook/test/{config,hmac,queue,deploy,server}.spec.ts`
  - `services/webhook/Dockerfile`
  - `scripts/deploy/{auto-deploy,rollout,rollback,health-wait,lock,test-syntax}.sh`
  - `scripts/backup/{db-backup,redis-backup,restore-test}.sh`
  - `services/backup/{Dockerfile,entrypoint.sh}`
  - `compose.deploy.yml`
  - `.env.deploy.example`
  - `.gitleaks.toml`, `.github/workflows/security.yml`,
    `scripts/gitleaks-staged.sh`
  - 7 runbooks under `docs/ops/runbook-*.md`
  - `docs/ops/deploy-inventory.md`

## Switchover DoD (post-merge, not in this branch)

Items the operator runs once, tracked in
`docs/ops/deploy-inventory.md § What stays manual`:

- [ ] `.env.deploy` created on NAS (0600 admin:users)
- [ ] `/volume1/backups/qufox/` created (0700 admin:users)
- [ ] `docker compose --env-file .env.deploy -f compose.deploy.yml up -d`
- [ ] Nginx diff applied + `nginx -s reload`
- [ ] GitHub webhook registered with matching secret
- [ ] Ping redeliver returns 200
- [ ] First auto-deploy observed end-to-end
- [ ] First scheduled daily backup observed
- [ ] First weekly restore smoke observed

## Risks

- **Webhook container crash ≠ app outage** — Compose split is
  deliberately independent. Manual path remains.
- **Queue starvation under burst** — Single-slot coalesce drops
  intermediate commits. Acceptable: tip SHA always builds.
- **Backup /volume1 runs out of space** — Daily × 14 + weekly × 8
  postgres dumps of a ~50 MB DB is ~1.2 GB; /volume1 has 1.6 TB free.
  Monitor via disk alert (separate task).
- **Migration step fails, app continues** — This is by design;
  migration failure aborts before any swap so the previous images keep
  serving. Downside: the failed deploy appears "hung" to the pusher.
  Runbook covers triage.
- **Rollback called with no `:prev` tag** — Possible on a fresh install
  or after manual image pruning. `rollback.sh` exits non-zero with a
  clear message; runbook escalates to SHA-pin fallback.

## Progress Log

- [x] UNDERSTAND — read `prod-reload.sh`, `docker-compose.prod.yml`,
      `.env.prod.example`, nginx.conf qufox.com block, Synology
      scheduler facilities, disk layout. Logged inventory doc.
- [x] PLAN — 8-commit sequence; user approved "모두 승인함" after 12
      clarifying questions.
- [x] SCAFFOLD + IMPLEMENT — 8 commits, commit sequence matches
      plan:
  1. `docs(deploy): inventory ...` (a03bebd)
  2. `feat(deploy): webhook server ...` (16c53a1)
  3. `feat(deploy): auto-deploy ...` (83e1546)
  4. `feat(deploy): backup + restore-test ...` (c07551c)
  5. `feat(deploy): compose.deploy.yml ...` (25493df)
  6. `test(deploy): webhook HMAC/queue/server ...` (768024e)
  7. `docs(deploy): 7 runbooks ...` (1770371)
  8. `chore(deploy): gitleaks ...` (b1284f6)
- [x] VERIFY — `pnpm verify` green (19/19 turbo tasks, 36/36 webhook
      specs); bash -n green; compose config green.
- [x] OBSERVE — post-merge; switchover DoD above tracked separately.
- [x] REFACTOR — none.
- [x] REPORT — PR #15 merged to develop at `c34f489`. Retroactive
      artefacts (this doc, review, PR body) written under task-010-A.
