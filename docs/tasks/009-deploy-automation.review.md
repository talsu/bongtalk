# Reviewer subagent — Task 009 Deploy Automation

## Header

- Branch reviewed: `feat/task-009-deploy-automation` (merged as PR #15)
- Diff range: `f65e71d..c34f489`
- Reviewer model: Opus 4.7 (1M context)
- Transcript length / tokens: ~45k prompt / ~5k output

## Verdict: request-changes

The architecture is sound — single-slot coalescing queue, flock-serialised
deploys, per-service rollout/rollback with health-wait, backup +
restore-smoke loop, HMAC webhook. Tests (36 specs) cover the observable
units well. But two production-fatal environment gaps would make the
very first auto-deploy fail every time: (1) the webhook container has
no GitHub credentials to `git fetch`, and (2) `POSTGRES_PASSWORD` is
not plumbed from `.env.prod` into the migration step's interpolation
context. Either one blocks the deploy before any container swap. There
is also a backwards GC loop that would prune the _newest_ images once
it actually runs. The single highest-risk item is the **missing SSH /
PAT credential path** for `git fetch origin <branch>` inside the
alpine webhook container — without it, `auto-deploy.sh` exits 2 on
every push.

## Findings

### 1. `git fetch` will fail inside the webhook container (no credentials mounted)

**BLOCKER** — `scripts/deploy/auto-deploy.sh:46` runs `git fetch --quiet
origin "$BRANCH"` inside the `qufox-webhook` container, which mounts
the host repo at `/repo` but nothing else.

The host's `origin` is `git@github.com:talsu/bongtalk.git` (SSH). The
webhook Dockerfile at `services/webhook/Dockerfile:18-19` installs
`docker-cli bash git curl tini` — no ssh-agent, no credential helper,
and `compose.deploy.yml:33-40` only bind-mounts the repo and
`/var/run/docker.sock`. There is no `~/.ssh` mount, no `GIT_SSH_COMMAND`
in env, and no `SSH_AUTH_SOCK` forwarded.

First real push arrives → `git fetch` → `Host key verification failed`
or `Permission denied (publickey)` → line 46 trips `exit 2`. Slack
posts `❌ deploy failed`. Every subsequent push does the same.

`docs/ops/runbook-deploy.md:15` handwaves "git fetch + checkout" as
taking "< 5s, 30s → exit 2" — i.e. an abort threshold is documented
but the root cause of that abort is the baseline state, not a timeout.

**Fix options:**

- Mount `/root/.ssh:/root/.ssh:ro` (or a dedicated `/home/node/.ssh`) in
  `compose.deploy.yml` with a read-only deploy key; add the key's pubkey
  to GitHub as a Deploy Key.
- Switch `origin` to HTTPS + PAT in a `.netrc` mounted into the container.
- Pre-fetch on the host and bind-mount the `.git` directory after (not
  really a fix).

Also: the runbook-webhook-debug.md "force-redeploy" one-liner at line
89-94 runs `auto-deploy.sh` on the NAS host where SSH works; the webhook
container path is the broken one. This divergence hides the bug during
smoke.

### 2. `POSTGRES_PASSWORD` is empty when interpolated into the migration container

**BLOCKER** — `scripts/deploy/auto-deploy.sh:55-56`:

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm \
  -e DATABASE_URL="postgresql://qufox:${POSTGRES_PASSWORD}@qufox-postgres-prod:5432/qufox?schema=public" \
  qufox-api pnpm --filter @qufox/api db:migrate
```

The `${POSTGRES_PASSWORD}` on line 56 is expanded by the **auto-deploy.sh
shell**, not by docker compose. That shell runs inside the webhook
container, whose env comes from `compose.deploy.yml:23` → `env_file:
[.env.deploy]`. `.env.deploy.example` does not include
`POSTGRES_PASSWORD` at all (`./.env.deploy.example:1-49`), and the
runbook at `docs/ops/runbook-secret-rotation.md:7` explicitly says
`POSTGRES_PASSWORD` lives in `.env.prod`.

So:

- `${POSTGRES_PASSWORD}` expands to empty string.
- `DATABASE_URL=postgresql://qufox:@qufox-postgres-prod:5432/...`.
- The explicit `-e DATABASE_URL=` overrides whatever `.env.prod` would
  have supplied via `--env-file`.
- Prisma fails with `password authentication failed for user "qufox"`.
- `exit 1`, deploy aborted, previous containers still serving (good
  containment, but every deploy is dead on arrival).

In practice the operator is forced to add `POSTGRES_PASSWORD=…` to
`.env.deploy` because `compose.deploy.yml:55` uses
`${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD for backup access}` — so
compose up-front _requires_ it. But this is a tribal-knowledge
requirement: not in the example file, not in the runbook, and a
perceptive operator reading secret-rotation.md would assume they can
keep the secret out of `.env.deploy`.

**Fix:**

- Remove the `-e DATABASE_URL=…` override entirely and let the service's
  own `DATABASE_URL` (defined in `docker-compose.prod.yml:45`) take
  effect — it already does `postgresql://qufox:${POSTGRES_PASSWORD:?}@…`
  and compose interpolates from `--env-file .env.prod`. No shell
  expansion in `auto-deploy.sh` needed.
- OR: `set -a; source .env.prod; set +a` near the top of
  `auto-deploy.sh` so the shell has the value.
- Add `POSTGRES_PASSWORD=change-me-strong-password` to
  `.env.deploy.example` with a comment pointing at `.env.prod`, and
  update `runbook-secret-rotation.md:7` to list `.env.deploy` alongside
  `.env.prod` for this key (it already mentions `.env.deploy`
  interpolation at line 69 but the top table is stale).

### 3. Image GC prunes the NEWEST images, not the oldest

**HIGH** — `scripts/deploy/auto-deploy.sh:82-93`. The intent in the
comment is "Sort by created-date, skip newest $KEEP, prune the rest"
but the implementation does the opposite:

```sh
mapfile -t stale < <(docker image ls --format '{{.Tag}} {{.CreatedAt}}' "$img" \
  | awk '/^sha-/ {print $1}' \
  | head -n "-$KEEP" 2>/dev/null || true)
```

`docker image ls` without `--sort` defaults to newest-first ordering.
`head -n -K` on a newest-first sequence means "everything except the
last K lines" = "everything except the K oldest". So `stale` ends up
being the **N−K newest tags**, and the loop calls
`docker image rm qufox/api:<newest>`, including `:latest` if it happens
to match `^sha-` (it won't, but the currently-used `sha-<short>` IS
in the stale set). That would yank the image the live container is
based on.

Two mitigations hide this in practice:

1. `docker image rm` on an image with a running container fails with
   "image is being used by running container". The `>/dev/null 2>&1 || true`
   eats that error. So the wheels stay on.
2. The webhook container ships **busybox head** (alpine base at
   `services/webhook/Dockerfile:5`, no `apk add coreutils`). Busybox
   head's `-n` does not accept negative values — it exits nonzero and
   prints nothing. The `2>/dev/null || true` masks the failure, so
   `stale` is `()`, and GC never actually runs. Disk bloat over
   time, but no damage.

So the bug is latent: when coreutils eventually lands in the image (or
a maintainer swaps base to debian) the GC pass will happily try to
rm the current image.

**Fix:** `| tail -n +$((KEEP+1))` is the correct idiom, but also needs
an explicit `--sort=created` or a pipe through `sort -r -k 2` since
`docker image ls` ordering is not contractually guaranteed. And add
`coreutils` to the webhook Dockerfile if the repository expects GNU
semantics anywhere in scripts/deploy.

A regression spec is worth it: a shell test that feeds a known list of
lines through the pipeline and asserts the right subset is flagged
stale. Suggest `scripts/deploy/test-gc.sh` using `<<<` to stub the
listing.

### 4. Webhook body cap (1 MB) is below GitHub's 25 MB ceiling

**HIGH** — `services/webhook/src/server.ts:22` sets
`readBody(req, maxBytes = 1_048_576)`. GitHub push payloads can be up
to ~25 MB (big initial pushes, force-pushes of large ranges, branches
with many commits in one push). `runbook-nginx-diff.md:38` even
documents `client_max_body_size 25m` at the edge — but the receiver
clamps at 1 MB.

Symptom: `readBody` rejects, handler returns 400, audit writes
`request.reject reason=body error="payload too large" delivery=…`,
GitHub marks the delivery failed, and depending on retry settings the
push is simply not deployed. No Slack alert for this class of failure
(the notifier only fires on `started` submission at line 141).

**Fix:** raise to 25 MB (or 32 MB for headroom) and document; also add
a `deliver.too_large` Slack notification so we catch this class of
failure at the edge.

A spec is worth it: POST a 1.5 MB body and assert 202 (currently 400).

### 5. `.env.deploy` is NOT in `.gitignore`

**HIGH** — `.gitignore` has `.env`, `.env.local`, `.env.*.local`,
`.env.prod` but no `.env.deploy`. On the NAS the operator creates
`.env.deploy` at repo root (per `compose.deploy.yml:23` and the
runbook). A mis-ordered `git add` inside the repo (the webhook
container has write access to the repo!) or an operator running
`git add .` on the host would stage the real `GITHUB_WEBHOOK_SECRET`
and any `POSTGRES_PASSWORD` copy kept there.

Gitleaks CI would catch some patterns (`.gitleaks.toml:16` already
allowlists `\.env\.example$` so the example file is exempt), and the
default rules cover generic high-entropy hex. But depending on the
generated secret's shape and the ruleset evolution, this is
hope-as-strategy. `.env.deploy` is a production secret file — the
gitignore should list it defensively.

Also `.deploy/` (audit log + per-deploy log dir) is not gitignored.
Deploy logs might include PII or tokens leaked from subprocess output
(the `onLog` callback in `services/webhook/src/deploy.ts:57-64` tails
stdout/stderr unredacted).

**Fix:** add `.env.deploy`, `.env.deploy.local`, and `.deploy/` to
`.gitignore`.

### 6. Audit log is unbounded append-only

**MED** — `services/webhook/src/audit.ts:22-34`. Every request and
every deploy result writes one JSON line to `/repo/.deploy/audit.jsonl`.
No rotation, no size check, no retention. Same for
`.deploy/logs/deploy-*.log` emitted by `scripts/deploy/auto-deploy.sh:30-33`
(`tee -a`).

Bursty PR-land days → multi-MB audit file by end of year; no cleanup
target in `prune` logic or in the backup container. Backup restore
logs accumulate in the same tree. Recovery plan on disk-full: manual
`> audit.jsonl`.

**Fix:** rotate by size/day (e.g. `audit-YYYY-MM-DD.jsonl` daily, prune

> 90 days), or simply pipe through `logrotate` config in the
> qufox-backup container since it already runs crond.

### 7. `runbook-deploy.md` claim that `prod-reload.sh` acquires the same flock is false

**MED** — `docs/ops/runbook-deploy.md:51-53`:

> Manual path (escape hatch)
> `scripts/prod-reload.sh [api|web|all]` still works and acquires the
> same flock as the webhook.

It does not. `scripts/prod-reload.sh` (the existing script, unchanged
by this task) never sources `scripts/deploy/lock.sh` and never calls
`deploy::acquire_lock`. A simultaneous push-deploy + manual reload
will race on `docker compose build` / `up -d --no-deps`, clobbering
each other's image retag. The docs say otherwise, so an operator
following the runbook will believe they're safe.

**Fix:** either teach `prod-reload.sh` to `. scripts/deploy/lock.sh &&
deploy::acquire_lock` (trivial, 3 lines), or correct the runbook to
say "do NOT run `prod-reload.sh` while the webhook is active — coordinate
via GitHub push freeze first".

### 8. `restore-test.sh` false-positives an empty DB

**MED** — `scripts/backup/restore-test.sh:68-73` asserts
`COUNT(*) FROM "User" > 0`. For a freshly initialized / seeded /
tested-empty workspace (user purges, pending product launch) the
backup would pass pg_restore structurally but fail the count. The
cron alert fires and operator chases a backup that is actually fine.

**Fix:** use a structural assertion (`SELECT COUNT(*) FROM
pg_tables WHERE schemaname='public'` > 10) plus a _conditional_ row
count (only require ≥1 User row if the live DB currently has ≥1 User
row). At minimum, change the failure message so it says "dump restored
cleanly but has 0 users — compare with live DB count" instead of
looking like data loss.

### 9. `redis-backup.sh` copies `dump.rdb` without confirming BGSAVE actually finished

**MED** — `scripts/backup/redis-backup.sh:37-47`. The LASTSAVE poll has
a 60s deadline and does `break` on first change. But if `BGSAVE`
errored (e.g. child process OOM, ENOSPC), LASTSAVE might still tick
(because a prior successful save updated it before this run's BGSAVE
started failing, so the value shifted between the `initial` read and
a concurrent save), OR never tick within 60s. The fallback path at
line 45-47 `[[ -f /redis-data/dump.rdb ]]` then gzips **whatever rdb
exists** — which could be mid-write or stale. There is no check that
the file's mtime is newer than the pre-BGSAVE moment.

Additionally, `redis-cli BGSAVE` returns `Background saving started`
immediately even when a save is already in progress. If another
save is in progress the response is `ERR An earlier save is still in
progress` — which line 33 discards (redirecting stdout to /dev/null).

**Fix:**

- Check `BGSAVE` response for "Background saving started" vs error.
- Record `initial` LASTSAVE **before** BGSAVE, wait for strict
  `current > initial`, and also assert the deadline was not hit before
  copying.
- After BGSAVE completes, check file mtime is ≥ the pre-BGSAVE clock.

### 10. `db-backup.sh` leaves `.tmp` behind on ENOSPC

**LOW** — `scripts/backup/db-backup.sh:33-38`. If `pg_dump` writes
partway into `qufox-$STAMP.dump.tmp` then hits ENOSPC, `set -e` aborts
BEFORE the `mv`, leaving the `.tmp` file on disk. Next day's run
reuses the same `$STAMP` format only if it runs on the same UTC date,
so usually the orphan lingers until manual cleanup. Cumulative orphans
can occupy disk that the rotation logic never touches (it only prunes
`qufox-*.dump`, not `.tmp`).

**Fix:** add `trap 'rm -f "$OUT_FILE.tmp"' ERR EXIT` just after the
mkdir.

### 11. Listener add-only (`queue.onSettled`) — no off

**LOW** — `services/webhook/src/queue.ts:29-31`:

```ts
onSettled(fn: (job: DeployJob, outcome: Outcome) => void): void {
  this.listeners.add(fn);
}
```

No `offSettled`. In the current wiring `main.ts` registers exactly one
listener at startup and never tears down, so this is fine. If future
code re-wires the queue (e.g. a metrics module re-initializing on
hot-reload or test setup), listeners pile up. `test/queue.spec.ts`
constructs a fresh `DeployQueue` per case so tests don't hit this.

**Fix:** return an unregister function, and use it in tests for
symmetry.

### 12. Webhook's `env.DEPLOY_SHA` is used raw in shell environment

**LOW** — `services/webhook/src/deploy.ts:47-53` sets
`DEPLOY_SHA: job.sha` which came from `payload.after` at
`services/webhook/src/server.ts:116` with only a `typeof === 'string'`
check. GitHub guarantees 40 hex chars, but there's no regex gate on
the webhook side. A spoofed (or future-different-format) SHA gets
written into the audit log, passed to `auto-deploy.sh`, which then
`git checkout --force "$SHA"`. git is defensive about arbitrary
strings but accepting unchecked input as a shell argument in a privileged
context is worth a cheap `/^[0-9a-f]{40}$/` validation on the webhook.

**Fix:** reject payloads where `after` doesn't match
`^[0-9a-f]{40}$`, same style as `extractBranch` in
`services/webhook/src/hmac.ts:19-24`.

### 13. Duplicate `X-GitHub-Delivery` replay — acceptable, but note

**NIT** — There is no dedupe by `X-GitHub-Delivery`. GitHub resends on
timeout (up to 3 attempts over ~30 minutes). If GitHub retries a push
whose first delivery succeeded with the queue already accepting it:

- SHA is the same → queue.submit returns `queued` or `coalesced`, not
  a fresh build. Idempotent by luck.
- If the first deploy already finished and the retry comes during an
  idle queue → second identical deploy runs end-to-end. Wastes ~2 min
  but produces the same image. Tolerable.

`services/webhook/test/server.spec.ts` does not exercise duplicate
delivery. Not a blocker but an explicit `it('is idempotent on repeated
X-GitHub-Delivery for the same SHA')` spec would pin the semantics.

### 14. `listenerErrors` silently swallowed — hides real bugs

**NIT** — `services/webhook/src/queue.ts:58-64`: listener exceptions
are swallowed with an empty `catch`. The `test/queue.spec.ts` suite
doesn't test "listener throws; queue survives", and the runner itself
(`main.ts:20-25`) passes the outcome to Slack notification which could
genuinely throw (network, serialization). If the Slack call later grows
a dependency that can throw synchronously, ops loses the signal.

**Fix:** `process.stderr.write` the error message before discarding.
Add a spec `listener errors are logged, not propagated`.

### 15. compose.deploy.yml: `qufox_qufox-prod-pgdata` assumes default project name

**NIT** — `compose.deploy.yml:69-75` references
`qufox_qufox-prod-pgdata` as an `external: true` volume. Compose
derives volume names from project name + volume key. The default
project name comes from the directory (`qufox`) but if anyone runs
`docker compose -p other-name …` or sets `COMPOSE_PROJECT_NAME`, the
actual volume is `other-name_qufox-prod-pgdata` and
`compose.deploy.yml up` fails to find the external volume.

Low likelihood given the docs pin the path. Worth a one-line assertion
in `runbook-deploy.md` or `deploy-inventory.md`: "do not set
`COMPOSE_PROJECT_NAME`; it must stay `qufox` for the backup volume
lookup to work".

### 16. Notifier absent-on-failure path

**NIT** — `services/webhook/src/main.ts:20-25` wires Slack on every
`onSettled`, but `server.ts:140-142` only sends a "🚀 started" Slack
message on `submission === 'started'`. Jobs that get `queued` or
`coalesced` while a deploy is already running never surface to Slack.
A user who pushes during an active deploy expects visual confirmation
their SHA is next. Not a bug — enqueued status IS in the 202 JSON
response GitHub receives, but the Slack channel loses the trace.

**Fix:** post "queued: branch@sha will deploy after current" on
`queued`/`coalesced` too.

## Items that look good (compliments)

- HMAC verification (`services/webhook/src/hmac.ts:5-17`) is textbook:
  prefix check, length check, `timingSafeEqual` wrapped in try/catch
  for hex-parse errors, unit tests cover the degenerate inputs.
- The single-slot coalescing queue is _exactly_ the right primitive for
  GitHub push fanout — no over-engineering, clear semantics, correct
  handling of synchronous runner throws (await wraps into rejection).
- Separating `compose.deploy.yml` from `docker-compose.prod.yml` so a
  webhook crash doesn't look like an app outage is good operational
  hygiene; the comment at `compose.deploy.yml:10-13` explains it.
- Weekly restore smoke test is the killer feature. An untested backup
  is Schrödinger's backup, and `scripts/backup/restore-test.sh:41`
  plumbs a trap-based teardown correctly.
- Audit log contract is deliberate: every request and every deploy
  settle emits one line. Grep-friendly shape.
- `scripts/deploy/test-syntax.sh` is a cheap + effective smoke — every
  shell script in the deploy/backup tree parses under `bash -n` before
  it can land. Good CI hygiene.
- `docs/ops/deploy-inventory.md` captures the _pre_-state of the
  manual deploy — future-you will thank past-you for this.

## Suggested follow-up TODOs

- **TODO(task-009-blocker-1)**: mount a GitHub deploy key (or equivalent
  token) into the `qufox-webhook` container so `git fetch` actually
  works. Document the setup step in `deploy-inventory.md` and
  `runbook-deploy.md`. Add a smoke spec that verifies `git ls-remote`
  succeeds as part of container startup.
- **TODO(task-009-blocker-2)**: remove the `-e DATABASE_URL=…` override
  from `auto-deploy.sh:55-56` and rely on `.env.prod` via
  `docker compose --env-file`. Update `.env.deploy.example` to
  document `POSTGRES_PASSWORD` with a pointer to `.env.prod`. Fix the
  stale table in `runbook-secret-rotation.md:7`.
- **TODO(task-009-high-1)**: fix the image-GC pipeline in
  `auto-deploy.sh:82-93` — use `tail -n +$((KEEP+1))` plus an explicit
  sort, and add `coreutils` to the webhook Dockerfile. Cover with a
  shell unit test that pipes a known listing.
- **TODO(task-009-high-2)**: raise the webhook body cap to ≥ 25 MB in
  `server.ts:22` (or make configurable via env). Add a 1.5 MB spec.
  Consider a "payload too large" Slack alert path.
- **TODO(task-009-high-3)**: add `.env.deploy`, `.env.deploy.local`,
  `.deploy/` to `.gitignore`.
- **TODO(task-009-med-1)**: rotate `audit.jsonl` and `.deploy/logs/`
  daily; prune past N days. Either via a cron entry in the qufox-backup
  container or a lightweight rotator at webhook startup.
- **TODO(task-009-med-2)**: teach `scripts/prod-reload.sh` to acquire
  the same flock as `auto-deploy.sh`, OR update runbook-deploy.md to
  warn it does NOT.
- **TODO(task-009-med-3)**: loosen `restore-test.sh` success criterion
  to "DB restored + expected tables present"; require ≥1 user only when
  live DB has ≥1 user.
- **TODO(task-009-med-4)**: harden `redis-backup.sh` — read LASTSAVE
  before BGSAVE, verify the BGSAVE command response, guard against
  stale/mid-write `dump.rdb` being copied.
- **TODO(task-009-low-1)**: add `trap 'rm -f "$OUT_FILE.tmp"' ERR EXIT`
  to `db-backup.sh` to clean orphan `.tmp` files on ENOSPC / crash.
- **TODO(task-009-low-2)**: validate `payload.after` matches
  `^[0-9a-f]{40}$` in `server.ts`.
- **TODO(task-009-nit-1)**: log listener errors (`queue.ts:58-64`) via
  stderr rather than silently dropping; extend queue.spec accordingly.
- **TODO(task-009-nit-2)**: Slack-notify on `queued` / `coalesced`
  submissions so pushers see their SHA is in the runway.
- **TODO(task-009-nit-3)**: add an idempotency spec for duplicate
  `X-GitHub-Delivery` in `server.spec.ts` to pin the current queue
  semantic.

## Resolution (task-010-A)

Fix commits landed on `feat/task-010-beta-polish`. The 009 merge to
develop is not reverted — these commits patch forward.

| Finding                                                 | Severity | Resolution                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. `git fetch` has no SSH creds inside webhook          | BLOCKER  | **Fixed**: `compose.deploy.yml` bind-mounts `${WEBHOOK_SSH_DIR:-/volume1/secrets/qufox-ssh}:/root/.ssh:ro`; `.env.deploy.example` documents the key.                                                                                                                                       |
| 2. `POSTGRES_PASSWORD` empty in migration step          | BLOCKER  | **Fixed**: removed the shell-expanded `-e DATABASE_URL=` override from `auto-deploy.sh`; `compose.deploy.yml` adds `.env.prod` as a second `env_file` so `docker compose run qufox-api` resolves `DATABASE_URL` via compose interpolation. `.env.deploy.example` documents the shared var. |
| 3. Image GC prunes newest                               | HIGH     | **Fixed**: `auto-deploy.sh` gc loop now uses `sort -r` + `tail -n +$((KEEP+1))` (works on busybox tail), keeps newest KEEP.                                                                                                                                                                |
| 4. Body cap 1 MB < 25 MB GitHub ceiling                 | HIGH     | **Fixed**: cap raised to 32 MB in `services/webhook/src/server.ts`; regression spec `body-size.spec.ts` asserts 1.5 MB 202s.                                                                                                                                                               |
| 5. `.env.deploy` + `.deploy/` not gitignored            | HIGH     | **Fixed**: `.gitignore` now lists `.env.deploy`, `.env.deploy.local`, `.deploy/`.                                                                                                                                                                                                          |
| 6. Audit log unbounded                                  | MED      | **Deferred**: TODO(task-009-med-1).                                                                                                                                                                                                                                                        |
| 7. Runbook claim `prod-reload.sh` shares flock is false | MED      | **Deferred**: TODO(task-009-med-2).                                                                                                                                                                                                                                                        |
| 8. `restore-test.sh` false-positives empty DB           | MED      | **Deferred**: TODO(task-009-med-3).                                                                                                                                                                                                                                                        |
| 9. `redis-backup.sh` BGSAVE-completion race             | MED      | **Deferred**: TODO(task-009-med-4).                                                                                                                                                                                                                                                        |
| 10. `.tmp` orphan on ENOSPC                             | LOW      | **Deferred**: TODO(task-009-low-1).                                                                                                                                                                                                                                                        |
| 11. Listener add-only (no `off`)                        | LOW      | **Deferred**: TODO(task-009-low-2) — listed as NIT in original text, keeping the priority.                                                                                                                                                                                                 |
| 12. `payload.after` unvalidated                         | LOW      | **Deferred**: TODO(task-009-low-3).                                                                                                                                                                                                                                                        |
| 13. Duplicate delivery spec missing                     | NIT      | **Deferred**: TODO(task-009-nit-3).                                                                                                                                                                                                                                                        |
| 14. Listener errors silently swallowed                  | NIT      | **Deferred**: TODO(task-009-nit-1).                                                                                                                                                                                                                                                        |
| 15. `compose_project_name` assumption                   | NIT      | **Deferred**: TODO(task-009-nit-4) — runbook note.                                                                                                                                                                                                                                         |
| 16. Slack silent on `queued`/`coalesced`                | NIT      | **Deferred**: TODO(task-009-nit-2).                                                                                                                                                                                                                                                        |

All deferred items are carried as TODO comments in the code or runbook
(numbered, not renamed to `task-009-hotfix` or similar). Grep for
`TODO(task-009-` to find every deferred item.
