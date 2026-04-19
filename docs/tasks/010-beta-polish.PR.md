# PR body — Task 010 Beta Polish (paste into GitHub)

**Target**: `feat/task-010-beta-polish` → `develop`

---

## Summary

Five independent chunks (A/B/C/D/E) closing 009 process debt,
shipping unread UI, finishing 008's deferred UX thread, instrumenting
the deploy pipeline we just built, and resolving the remaining
002-review items.

### A. 009 process-debt closure

- Retroactive task doc + reviewer-subagent review (~106k tokens) +
  pasteable PR body + evals 022 (tampered HMAC → 401+audit) / 023
  (rollout health-fail → rollback).
- Reviewer returned **request-changes** with 2 BLOCKERs + 3 HIGHs.
  All fixed forward on this branch:
  - SSH deploy-key mount (`${WEBHOOK_SSH_DIR}:/root/.ssh:ro`) in
    compose.deploy.yml — 009's `git fetch` would have auth-failed.
  - `POSTGRES_PASSWORD` plumbed via `.env.prod` second env_file in
    compose.deploy.yml (removes the broken `-e DATABASE_URL=…`
    shell-expansion in auto-deploy.sh).
  - Image GC uses `sort -r | tail -n +$((KEEP+1))` (keeps newest, not
    oldest; works on busybox).
  - Webhook body cap raised from 1 MB to 32 MB; regression spec.
  - `.env.deploy`, `.env.deploy.local`, `.deploy/` added to
    `.gitignore`.
  - MED/LOW/NIT findings mapped to `TODO(task-009-*)` markers (see
    review.md's resolution table).

### B. Unread UI end-to-end

- API: `GET /workspaces/:id/unread-summary` (one row per channel,
  single query with `LATERAL` for `count + bool_or + max` joined on
  `UserChannelReadState.lastReadAt`). `POST
/workspaces/:id/channels/:chid/read` upserts `lastReadAt = now()`.
- Integration spec covers post-read / pre-read / mention / everyone /
  self-message branches.
- Frontend: `useUnreadSummary` + `useMarkChannelRead` hooks, dispatcher
  branch bumping unread on `message.created` from other users, sidebar
  dot + pill with mention-colour bump. Semantic tokens only.
- E2E: `apps/web/e2e/realtime/unread-propagation.e2e.ts` covers the
  two-context propagation + clear-on-open + mention variant.

### C. 008 deferred UX closure

- CommandPalette gains full WAI-ARIA combobox wiring (`role=combobox`,
  `aria-controls`, `aria-expanded`, `aria-activedescendant`).
- ChannelList inline submit buttons use the `Button` primitive for
  consistent `focus-visible:ring`.
- Palette→token migration on LoginPage / SignupPage / ProtectedRoute /
  CreateWorkspacePage / InviteAcceptPage (zero `bg-slate-*` etc in
  features/auth + features/workspaces).
- ESLint `no-restricted-syntax` rule: **warn** globally on
  `apps/web/src/**`, **error** on the two migrated trees. Added
  `@typescript-eslint/parser` so TS/TSX actually parses under flat
  config. `scripts/test-eslint-palette-rule.sh` proves the rule fires.
- Three pre-existing latent issues surfaced by the parser switch and
  fixed in the same commit (see C commit body for details).

### D. Deploy pipeline observability

- 4 prom-client metrics in services/webhook:
  `qufox_deploys_total{result="ok|fail|rollback"}` (seeded to 0),
  `qufox_deploy_duration_seconds` (histogram
  `[10,30,60,120,240,480]`), `qufox_deploy_queue_depth` gauge,
  `qufox_deploy_rollbacks_total` counter.
- `GET /internal/metrics` endpoint with 127.0.0.1 + docker-bridge IP
  allowlist. `POST /internal/rollback-reported` for
  `scripts/deploy/rollback.sh` → curl callback (fail-open).
- `infra/prometheus/prometheus.yml` + `alerts-deploy.yml` for
  docker-compose Prometheus; `infra/k8s/monitoring/alerts.yaml` +
  `servicemonitor-webhook.yaml` for the future K8s deploy;
  `infra/grafana/dashboards/deploy.json` with rollout p50/p95, deploys
  by result, rollbacks 7d, queue depth.
- 8 new vitest specs (webhook now 45/45 pass).

### E. 002 review ageing items

- `apps/api/src/config/required-env.ts` with `assertProductionEnv`
  called from main.ts bootstrap — refuses to start if WEB_URL is
  missing or a known dev-default in production.
- Delete unused `CurrentWorkspace` decorator.
- `TODO(task-011..014)` markers in-situ for: per-code invite-accept
  rate limit; error-code fidelity in `accept` CAS-0-rows;
  `transferOwnership` $transaction serializable; soft-delete purge
  worker.
- `transferOwnership` already uses `outbox.record(tx, ...)` (correct
  outbox pattern) — the 002-review item that asked for "move emit()
  outside transaction" was already resolved upstream; documented.

## Test plan

- [x] `pnpm verify` — **19/19 turbo tasks green** after every chunk.
- [x] `pnpm --filter @qufox/webhook test` — 45/45 (36 pre-existing +
      body-size + 8 metrics specs).
- [x] `pnpm --filter @qufox/web test` — 4/4.
- [x] `pnpm --filter @qufox/api test` — 50/50 unit.
- [x] `scripts/test-eslint-palette-rule.sh` — exits 1 on synthetic
      fixture, grep'd for `no-restricted-syntax` in output.
- [x] Regression grep: `TODO(task-003-blocker|TODO(task-002-hotfix)` →
      0 matches.
- [x] Palette grep: `bg-slate-|bg-red-|text-red-|bg-blue-|bg-green-|bg-yellow-`
      on `apps/web/src/features/auth` + `apps/web/src/features/workspaces`
      → 0 matches.
- [ ] `pnpm --filter @qufox/api test:int` — **NOT RUN** in this
      environment. `web-url-assert.int.spec.ts` is a pure-function test
      (no testcontainers) and will pass. `unread-summary.int.spec.ts`
      requires postgres + redis testcontainers; implementer did not
      have docker-in-docker on the NAS to exercise it, so this is a
      file-level assertion only.
- [ ] `pnpm --filter @qufox/web test:e2e` — **NOT RUN** in this
      environment. Both `command-palette-a11y.e2e.ts` and
      `unread-propagation.e2e.ts` exist and are correct shape; running
      them needs the full stack (api+web+postgres+redis) running, which
      is the switchover-day / CI-day concern.
- [x] Reviewer subagent spawned for **009** (transcript archived,
      BLOCKERs fixed forward) and **010** (spawned against this
      branch; see `docs/tasks/010-beta-polish.review.md`).

## Commit sequence

```
9a602af chore(api):    task-010-E — resolve 002 review ageing items
241cfec chore(deploy): task-010-A — 009 process-debt closure + review BLOCKER fixes
8b3c786 feat(web):     task-010-C — 008 deferred UX closure (a11y + tokens + ESLint)
8cba59f feat(deploy):  task-010-D — deploy pipeline observability
7106382 feat(unread):  task-010-B — unread summary + mark-read end-to-end
```

(plus a final reviewer-response commit if the 010 reviewer raises
BLOCKERs — will be appended before this PR is opened for merge.)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
