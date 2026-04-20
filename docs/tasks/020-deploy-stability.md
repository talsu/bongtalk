# Task 020 — Deploy Stability: OutboxHealthIndicator idle/stalled + API Dockerfile chmod + umask regression guard + E2E race fix → main deploy

## Context

Task 019's main auto-promotion ran the pipeline end-to-end for the
first time and it mostly worked — reviewer caught issues, they got
fix-forwarded, three post-deploy hotfixes landed on main. Along the
way three pre-existing pipeline issues surfaced. They didn't
corrupt prod but they wasted rollout time and will burn every
future deploy:

1. **`OutboxHealthIndicator` can't tell idle from stalled.** The
   indicator treats "no dispatch event in the last 10 seconds" as
   degraded. During quiet periods (night, immediately after a
   deploy) the outbox legitimately has nothing to do, but
   `/readyz` returns 503 and `auto-deploy`'s health-wait gate
   fails. 019's API rollout failed this way and auto-rollback
   fired; the real service was fine the whole time.
2. **`apps/api/Dockerfile` never got the chmod fix** from 019. Web
   Dockerfile now does `chmod -R a+rX` to work around NAS umask
   0077 stripping world-readable bits at build time. API image
   still inherits host umask; a rebuild on a fresh NAS with strict
   umask will ship 0600 files and nginx-served assets break.
3. **`notification-settings.e2e.ts` race** — page loads, radio
   is clicked before `GET /me/notification-preferences` resolves,
   preference list hasn't painted yet. Flaky on GHA.

Task 020 fixes all three plus adds a Docker-build regression
guard in CI so the umask issue can't return silently. Scope is
strict hygiene — no features — and ends with the standard
develop → main auto-promotion.

## Scope (IN)

### A. `OutboxHealthIndicator` — idle vs stalled

Current implementation (`apps/api/src/observability/health/outbox-health.indicator.ts`,
wired in 007) marks degraded on "no dispatch event within
`<staleThreshold>`". Replace the discriminator with outbox
backlog:

```
unprocessed = SELECT count(*) FROM outbox_events
              WHERE dispatched_at IS NULL
              AND created_at < now() - interval '<staleThreshold>'

if unprocessed > 0:
  status = degraded ("stalled")
else:
  status = ok ("idle")
```

- Existing Prometheus gauge `qufox_outbox_health` keeps its label
  surface (`healthy` / `idle` / `stalled`) so Grafana + alert
  rules in `infra/prometheus/alerts.yml` don't break.
- `/readyz` handler: only `stalled` and non-`ok` DB/Redis states
  return 503. `idle` is 200.
- Alert rule audit: if any Prometheus rule still fires on
  `qufox_outbox_health{state="idle"}`, remove / rewrite.
- Integration spec `apps/api/test/int/observability/outbox-health-idle-vs-stalled.int.spec.ts`:
  - Case 1: empty outbox, no dispatch ticks → `ok` + `/readyz`
    200
  - Case 2: one row with `dispatched_at IS NULL` older than the
    threshold, no dispatch ticks → `degraded stalled` +
    `/readyz` 503
  - Case 3: insert a row, run one dispatch tick, assert cleared
    — `ok` + `/readyz` 200

### B. `apps/api/Dockerfile` chmod + Docker umask regression guard

- Add `RUN chmod -R a+rX /app` (or equivalent for the actual
  output path that the runtime stage owns) to `apps/api/Dockerfile`
  at the end of the runtime stage, mirroring `apps/web/Dockerfile`.
- New guard script `scripts/deploy/tests/dockerfile-umask-smoke.sh`:
  - `umask 0077` at script entry
  - Build both api and web images from scratch (no cache, so the
    effect reproduces)
  - For each image: run a short disposable container that `ls -la`
    the `/app/dist` (api) or `/app/public` (web) directory and
    asserts every file is at least `a+r` (world-readable)
  - Exit non-zero if any file is 0600 / missing read
- Wire into GHA: new job `docker-umask-smoke` in
  `.github/workflows/integration.yml` (or a new workflow file if
  cleaner), runs on PR + push to develop/main.
- Add `pnpm docker:build:smoke` root script so developers can run
  it locally before a prod promotion.

### C. `notification-settings.e2e.ts` race

- Add `await page.waitForResponse(r =>
  r.url().includes('/me/notification-preferences')
  && r.request().method() === 'GET'
  && r.status() === 200)`
  immediately after navigating to `/settings/notifications`,
  before the first radio click.
- Audit sibling settings tests for the same pattern; apply the
  same fix wherever a settings page reads preferences before
  interaction.

### D. develop → main auto-promotion + deploy verification

Standard flow per `feedback_auto_promote_to_main.md`:

1. feat branch + reviewer approve + develop merge + push
2. `git checkout main && git pull --ff-only`
3. `git merge --no-ff develop -m "Deploy task-020 to prod: deploy stability fixes"`
4. `git push origin main`
5. Wait 1–3 minutes
6. Verify `tail -1 /volume2/dockers/qufox/.deploy/audit.jsonl` — `exitCode=0`, `sha` matches main tip
7. Verify `curl -sk https://qufox.com/api/readyz` returns **200**
   — this task specifically checks 200 in the idle state, proving
   the indicator fix worked live
8. REPORT includes develop SHA, main SHA, exitCode, `/readyz`
   response code, deploy duration, and a note that `/readyz` was
   green while outbox was idle

## Scope (OUT)

- New features (mobile responsive drawer, Loki, mecab-ko, custom
  emoji, etc.) — future tasks.
- Refactor of other health indicators (DB, Redis) — they work.
- New `/readyz` endpoints or API shape changes.
- 010/011/012 residual LOW/NIT.

## Acceptance Criteria (mechanical)

- `pnpm verify` green.
- `pnpm --filter @qufox/api test:int` green on GHA with new spec:
  - `outbox-health-idle-vs-stalled.int.spec.ts` (3 cases).
- `pnpm --filter @qufox/web test:e2e` green on GHA; the
  `notification-settings.e2e.ts` re-run 3× in CI all pass (race
  fix landed).
- `bash scripts/deploy/tests/dockerfile-umask-smoke.sh` green
  locally (umask 0077 explicit) and on GHA.
- New GHA workflow step `docker-umask-smoke` visible in the PR
  check list.
- TODO regression:
  `grep -rn 'TODO(task-019-follow-1\|TODO(task-019-follow-2\|TODO(task-019-follow-3' --include='*.ts' --include='*.tsx' --include='*.sh' .` returns **0 lines**.
- Three artefacts: `020-*.md`, `020-*.PR.md`, `020-*.review.md`.
- One eval added: `evals/tasks/036-outbox-health-idle-vs-stalled.yaml`.
- Reviewer subagent actually spawned; transcript token count
  recorded in review.md.
- Direct merge to develop (PR skipped).
- **develop → main auto-promoted + pushed.**
- **`audit.jsonl` last entry shows `exitCode=0` with sha matching
  `origin/main` tip.**
- **`GET https://qufox.com/api/readyz` returns 200 after deploy.**
- REPORT includes:
  - develop merge SHA
  - main merge SHA
  - deploy exitCode
  - `/readyz` response code
  - deploy duration seconds
  - confirmation that `/readyz` stayed 200 during the idle
    window right after deploy (the specific regression we fixed)
- Feature branch retained.

## Prerequisite outcomes

- 019 merged to develop + main (`8d48923`).
- `OutboxHealthIndicator` from 007 exists and is the component
  under change.
- `apps/web/Dockerfile` has the chmod pattern from 019's
  post-deploy hotfix (`8d48923` scope).
- `.github/workflows/integration.yml` active from 011-D.
- `auto-deploy.sh` health-wait gate hits `/readyz` (009-A).

## Design Decisions

### Idle vs stalled is "backlog > 0"

The absence of a dispatch event can mean two things. The cheap
discriminator is "is there anything the dispatcher should have
handled and didn't?" — measured by unprocessed outbox rows older
than the stale threshold. Zero backlog = idle = fine. Non-zero
backlog + no dispatch tick = stalled. This matches the actual
failure mode that should page someone.

### Gauge label surface preserved

Operations already has alerts and dashboards keyed on
`qufox_outbox_health{state="healthy"|"idle"|"stalled"}`. Changing
the label set would break dashboards + alerts silently. The
semantic change lives in the `/readyz` judgement, not in the
metric.

### Dockerfile smoke runs on every PR, not just release

NAS umask regression is a property of the build environment, not
the code change. It can sneak in through a Dockerfile edit, a
base-image bump, or a package add. PR-time CI is the right place
to catch it, before a bad image reaches main.

### `waitForResponse` is the E2E race fix, not longer timeouts

Raising Playwright wait timeouts masks races by hoping the
preference fetch finishes in time. Explicit wait on the actual
response keeps the test asserting the real contract.

## Non-goals

- Changing the stale threshold itself (keep the 007-era value).
- Redesigning `/readyz` response shape.
- Adding a separate "outbox backlog" gauge (the existing gauge
  - label is enough for this fix).
- Refactoring the Nest health module architecture.

## Risks

- **Existing integration tests expect `/readyz` 503 in idle**.
  007's own `health.degraded` test specifically drives degraded
  and expects 503. Audit before changing; tests that drove
  "idle → 503" should switch to "backlog-stalled → 503".
- **Prometheus alert on `state="idle"`** — if one exists, the
  fix flips its trigger from "fires constantly during quiet
  hours" to "never fires". Either acceptable (alert was noise),
  or a replacement alert is needed on `stalled`. Audit in
  UNDERSTAND.
- **Docker smoke on GHA may not reproduce umask 0077**. GHA
  ubuntu-latest defaults to 022. Setting `umask 0077` in the
  script is sufficient at the shell level; cross-check that
  `docker build` inherits the setting (Docker daemon may use
  root's umask independently). If `docker build` doesn't honour
  the script's umask, fall back to building with a BuildKit
  frontend that pins 0077 via `ARG`, or test the outcome by
  unpacking the built image tar and checking permissions.
- **Outbox backlog count query performance**. New COUNT(\*) hits
  on every `/readyz` poll. Mitigation: partial index
  `(dispatched_at) WHERE dispatched_at IS NULL` if not already
  there, or cache the count with a short TTL (≤1 s) inside the
  indicator. Benchmark before shipping; likely a non-issue at
  beta volume.
- **Main auto-promote hotfix risk**. 019's pattern (3 hotfixes
  on main directly after merge) could repeat. This task is
  hygiene-only and touches narrow surfaces (one health
  indicator, one Dockerfile line, one E2E wait), so risk is
  lower; still, reviewer should spot any surface beyond the
  three targets.
- **E2E race audit in sibling tests** finds more than expected.
  If five other settings-style tests have the same race, scope
  creeps. Mitigation: fix the obvious `notification-settings`
  one as AC, list any others in follow-ups for a future sweep.

## Progress Log

_Implementer fills. Order: A → B → C → D._

- [ ] UNDERSTAND (current `OutboxHealthIndicator` implementation,
      existing 007 tests that assert `/readyz` behaviour, web
      Dockerfile chmod pattern, alert rules that reference
      `qufox_outbox_health` labels, GHA workflow file layout)
- [ ] PLAN approved
- [ ] SCAFFOLD (new int spec red against current indicator,
      Docker smoke skeleton, E2E wait addition)
- [ ] IMPLEMENT (A → B → C)
- [ ] VERIFY (`pnpm verify` + GHA int + e2e + docker-umask-smoke
      green)
- [ ] OBSERVE (idle state sample + `/readyz` 200; stalled state
      sample + `/readyz` 503; umask smoke output shows
      world-readable permissions)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main merge → push main →
      `audit.jsonl exitCode=0` + `/readyz` 200 in idle window →
      REPORT printed automatically with all SHAs + deploy
      result + idle-window confirmation)
