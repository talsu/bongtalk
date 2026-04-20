# Running test:int and test:e2e on the NAS locally

> Object storage in this project is a MinIO container running on the NAS
> (bind-mounted at `/volume3/qufox-data/minio/`); the API talks to it via
> the AWS S3 SDK because MinIO speaks the S3 wire protocol. Env var and
> service names like `S3_ENDPOINT` / `S3Service` refer to that protocol,
> not to any cloud target.

Before task-012, these two test pipelines were GHA-only on this
project: `test:int` failed to boot the Nest app because `S3Service`
threw on missing `S3_ENDPOINT`, and `test:e2e` needed a compose stack
nobody set up. Task-012 fixed the S3Service startup (lazy init) so
`test:int` works against testcontainers on the NAS, and this runbook
captures the `test:e2e` steps.

## `pnpm --filter @qufox/api test:int`

Uses testcontainers to spin its own Postgres 16 + Redis 7. Docker is
already on the NAS; no extra setup.

```sh
cd /volume2/dockers/qufox/apps/api
TESTCONTAINERS_RYUK_DISABLED=true pnpm test:int
# or a single spec:
TESTCONTAINERS_RYUK_DISABLED=true pnpm test:int --run test/int/auth/auth.int.spec.ts
```

`TESTCONTAINERS_RYUK_DISABLED=true` matches the GHA pattern — Ryuk
is the cleanup-sidecar container that testcontainers normally spawns,
but it doesn't work reliably on this Synology docker build. The test
helpers stop their own containers in `afterAll` hooks so skipping
Ryuk is safe.

Expected: 14 spec files × ~9s container boot + actual tests. Whole
suite ~3–4 minutes. Individual specs:

- `auth.int.spec.ts` → 16/16 green (task-001)
- `messages.int.spec.ts` → 6/6 green (task-004)
- everything else → run it and see; any regression is a task-012 or
  newer issue.

Known failure: `channels/unread-summary.int.spec.ts` uses the
shared-seed `seedWorkspaceWithRoles` which builds its workspace slug
from `Date.now().toString(36)` — `vi.setSystemTime` freezes the
clock, so four tests in the same file request the SAME slug and the
last three 409. Flag for a follow-up: add a random suffix + a guard
against the 401 path (still being diagnosed).

## `pnpm --filter @qufox/web test:e2e`

Needs the full app stack up (api + web + postgres + redis). The
`docker-compose.test.yml` from task-011-D is the vehicle:

```sh
cd /volume2/dockers/qufox
# 1. bring the test stack up. `build` because test-api / test-web are
#    built from the repo; subsequent runs cache.
docker compose -f docker-compose.test.yml up -d --build

# 2. wait for the api /readyz. At beta scale this is 30-60s.
until curl -sk -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:43001/readyz | grep -q 200; do
  sleep 2
done
echo "api up"

# 3. install playwright browsers once per machine.
cd apps/web
pnpm exec playwright install --with-deps chromium

# 4. run the tests. PLAYWRIGHT_BASE_URL + VITE_API_URL match the
#    compose-exposed ports.
PLAYWRIGHT_BASE_URL=http://localhost:45173 \
VITE_API_URL=http://localhost:43001 \
  pnpm exec playwright test

# 5. single spec:
pnpm exec playwright test e2e/auth/login.e2e.ts

# 6. teardown.
cd /volume2/dockers/qufox
docker compose -f docker-compose.test.yml down -v
```

If Playwright's HTML reporter complains about EACCES on
`playwright-report/index.html`, the `.pnpm/` store is read-only for
your user — run `chmod -R u+w apps/web/playwright-report` once, or
pass `--reporter=list` to skip the HTML write.

## Attachment E2E on the NAS

Task-013-A4 added `test-minio` + `test-minio-init` services to
`docker-compose.test.yml` so the three attachment E2Es from
task-012-C/E run locally end-to-end. `docker compose -f docker-compose
.test.yml up -d --build` spins MinIO alongside Postgres / Redis;
attach the `qufox-attachments` bucket is seeded by the init
container and ready before `test-api` reports healthy.

## Troubleshooting

- **Port already in use (5432 / 6379)** — the dev compose stack uses
  those ports too. Stop it first: `pnpm db:down`.
- **Ryuk container exits immediately** — that's the
  `TESTCONTAINERS_RYUK_DISABLED=true` case; safe to ignore.
- **"docker daemon not reachable"** — confirm `/var/run/docker.sock`
  is accessible: `ls /var/run/docker.sock`. On Synology this is
  `root:root 660`; running as `admin` requires membership of the
  `docker` group.
- **Test files appear "skipped" in the vitest output** — likely a
  `beforeAll` setup error. Check the first error line above the
  skip count; usually it's a failed migration or a missing env var.
