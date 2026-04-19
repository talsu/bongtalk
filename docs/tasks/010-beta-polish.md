# Task 010 — Beta Polish: 009 Closure + Unread/A11y + Deploy Observability

## Context

Task 009 landed a production-grade deploy pipeline (HMAC webhook → queued
rollout → /readyz gate → automatic rollback, daily Postgres/Redis backups
with weekly restore smoke, seven ops runbooks). Verify was 19/19 green and
the 36 webhook specs pass. But three process-continuity artefacts were
skipped: the task doc under `docs/tasks/`, the reviewer-subagent report,
and the PR body. No evals entry was added either.

Meanwhile 005 wrote `UserChannelReadState` rows but never rendered them;
the sidebar has no unread signal. Task 008's reviewer left four deferred
UX items. And three small 002-review follow-ups (`WEB_URL` boot assert,
`emit()` inside `$transaction`, the dead `CurrentWorkspace` decorator)
never got a task number.

Task 010 folds these into one beta-readiness pass: close 009, finish the
two deferred UX threads that make the app feel like Discord rather than
"a chat with no unread indicator," and instrument the deploy pipeline we
just built so we can see it working.

No new domain features. No database migrations beyond whatever
`unread-summary` might need (expected: none — read-state table already
exists).

## Scope (IN)

### A. 009 process-debt closure

- Retroactive task doc at `docs/tasks/009-deploy-automation.md` — full
  Context / Scope (IN/OUT) / Acceptance Criteria / Risks / Progress Log,
  written from the actual committed artefacts (not wish-list).
- Reviewer subagent **actually spawned** against the
  `feat/task-009-deploy-automation` diff (develop..HEAD). Output captured
  at `docs/tasks/009-deploy-automation.review.md` with verdict + findings
  - resolution column.
- Any BLOCKER the reviewer raises → fix commits on the same branch before
  merge, appended to the review doc's resolution column.
- PR body at `docs/tasks/009-deploy-automation.PR.md` (pasteable into the
  GitHub UI since NAS has no `gh`).
- Evals: `evals/tasks/022-webhook-hmac-reject.yaml` (tampered body rejected
  with 401, audit row written) and `evals/tasks/023-deploy-rollout-health.yaml`
  (health-wait times out → rollback.sh fires → `:prev` tag restored).

### B. Unread UI (closes TODO(task-027) from 005)

- Backend: `GET /workspaces/:id/unread-summary` returns
  `{ channelId, unreadCount, hasMention, lastMessageAt }[]` for every
  channel the caller can read. Single query, aggregates by joining
  `UserChannelReadState.lastReadMessageId` with `Message.createdAt`.
  EXPLAIN verified (DNA) — expect index scan on
  `(channelId, createdAt)`, no seq scan.
- Frontend: dispatcher branch in `features/realtime/dispatcher.ts` — on
  `channel.message.created` where `sender.id !== viewer.id` and channel
  is not currently open, bump the React Query `unreadSummary` cache
  entry for that channel. Mention-aware bump re-uses the already-parsed
  `mentions[]` payload from 004.
- Opening a channel fires `POST /channels/:chid/read` which upserts
  `UserChannelReadState.lastReadMessageId` to the latest message in the
  viewport. Debounced 500ms on scroll-to-bottom.
- `ChannelList` in the 008 shell gains a dot (unread) and optional
  `[N]` pill (count), with the dot color bumped for mentions. Semantic
  tokens only.
- Playwright E2E at `apps/web/e2e/unread-propagation.e2e.ts`: two
  browser contexts, one posts, the other sees unread bump in sidebar;
  second context opens the channel and unread goes to zero; mention
  variant asserts distinct dot color.

### C. 008 deferred UX closure

- `CommandPalette` combobox a11y: `role="combobox"` on the input,
  `aria-activedescendant` pointing at the focused option, `aria-expanded`
  synced with open state. axe run on palette → 0 violations of serious+.
- `ChannelList` inline submit buttons (create-channel, create-category):
  explicit `focus-visible:ring` classes via design-system primitive so
  the focus outline is consistent with the rest of the shell.
- Replace hard-coded `slate-*` / `red-*` / similar Tailwind colors with
  semantic tokens on:
  - `features/auth/LoginPage.tsx`
  - `features/auth/SignupPage.tsx`
  - `features/workspaces/CreateWorkspacePage.tsx`
  - `features/workspaces/InviteAcceptPage.tsx`
- ESLint rule — `no-restricted-syntax` entry that matches
  `className` strings containing raw palette classes (`bg-(slate|red|
blue|green|yellow)-\d+`), scoped initially to `apps/web/src/features/auth/`
  and `apps/web/src/features/workspaces/`. Warning elsewhere; error in
  those two trees. Expands in a later task.

### D. Deploy pipeline observability

- `services/webhook` gains `prom-client` and a `/metrics` endpoint on
  the same port as the hook receiver but under `/internal/metrics`
  (IP allowlist: only the host Prometheus). Four metrics:
  - `qufox_deploys_total{result="ok|fail|rollback"}` (counter)
  - `qufox_deploy_duration_seconds` (histogram, buckets
    `[10, 30, 60, 120, 240, 480]`)
  - `qufox_deploy_queue_depth` (gauge, snapshot each enqueue/dequeue)
  - `qufox_deploy_rollbacks_total` (counter, emitted from
    `scripts/deploy/rollback.sh` via a tiny `curl -XPOST` callback
    into the webhook process)
- Prometheus scrape target added to `infra/prometheus/prometheus.yml`
  (or equivalent live config) for `deploy.qufox.com:<port>`.
- One Grafana panel added to the existing deploy dashboard: rollout
  duration P50/P95 over 24h, fail+rollback counters over 7d.
- Alert in `infra/prometheus/alerts.yml`:
  - `DeployRollbackSpike`: `increase(qufox_deploy_rollbacks_total[15m]) > 1`
    → page (runbook link: `docs/ops/runbook-webhook-debug.md`)
  - `DeployFailStreak`: two consecutive
    `qufox_deploys_total{result="fail"}` within 30m → warn

### E. 002 review ageing items (3 resolved, rest numbered)

- Resolve:
  - `WEB_URL` boot-time assert: `apps/api/src/main.ts` (or config
    module) refuses to start in `NODE_ENV=production` if `WEB_URL` is
    unset or equals the dev default.
  - `transferOwnership.emit()` inside `$transaction` — move after the
    transaction commits. Grep audit on every other `.emit()` call site
    for the same anti-pattern; fix inline if found.
  - Remove the unused `CurrentWorkspace` decorator at
    `apps/api/src/workspaces/decorators/current-workspace.decorator.ts`.
- Number-and-defer (update review doc's TODO markers):
  - `TODO(task-011)`: rate-limit `GET /invites/:code` (per IP, 60/min)
    and per-code rate limit on `POST /invites/:code/accept`.
  - `TODO(task-012)`: improve error-code fidelity in
    `invites.service.ts::accept` CAS-0-rows path — distinguish
    `INVITE_NOT_FOUND` / `INVITE_EXPIRED` / `INVITE_EXHAUSTED` /
    `INVITE_REVOKED`.
  - `TODO(task-013)`: bump `transferOwnership`'s `$transaction` to
    `isolationLevel: 'Serializable'`.
  - `TODO(task-014)`: schedule the soft-delete purge worker that acts
    on `Workspace.deleteAt`.

## Scope (OUT) — future tasks

- Mention notifications / toast delivery — TODO(task-021).
- Attachments (S3) — TODO(task-017).
- Reactions — TODO(task-023).
- Threads / replies — TODO(task-024).
- Full-text search — TODO(task-025).
- PITR / WAL archiving — separate ops task.
- Secret management upgrade (sops / Vault) — separate ops task.
- Loki log aggregation — TODO(task-019).
- Tail-based sampling policy — TODO(task-020).

## Acceptance Criteria (mechanical)

- `pnpm verify` green. Log attached to the PR body.
- `pnpm --filter @qufox/webhook test` green, including new specs for
  the four metrics + /internal/metrics IP allowlist.
- `pnpm --filter @qufox/api test:int` covers
  `unread-summary.int.spec.ts` and `web-url-assert.int.spec.ts`.
- `pnpm --filter @qufox/web test:e2e` green, with new files:
  - `apps/web/e2e/unread-propagation.e2e.ts`
  - `apps/web/e2e/command-palette-a11y.e2e.ts`
- `grep -rn 'bg-slate-\|bg-red-\|text-red-\|bg-blue-\|bg-green-\|bg-yellow-' apps/web/src/features/auth apps/web/src/features/workspaces`
  returns **0 matches**.
- `grep -rn 'TODO(task-003-blocker\|TODO(task-002-hotfix' .` returns
  **0 matches** (regression guard).
- Files exist:
  - `docs/tasks/009-deploy-automation.md`
  - `docs/tasks/009-deploy-automation.review.md`
  - `docs/tasks/009-deploy-automation.PR.md`
  - `docs/tasks/010-beta-polish.PR.md`
  - `docs/tasks/010-beta-polish.review.md`
  - `evals/tasks/022-webhook-hmac-reject.yaml`
  - `evals/tasks/023-deploy-rollout-health.yaml`
- `curl -sf http://127.0.0.1:<webhook-port>/internal/metrics` from the
  host returns 200 with the four `qufox_deploy_*` metric families
  present.
- ESLint rule firing on a synthetic hard-coded-color test file causes
  `pnpm lint` to exit non-zero.
- Reviewer subagent **actually spawned** for both Task 009 (retroactive)
  and Task 010. Transcript length + token count recorded in each
  review doc's header.

## Prerequisite outcomes

- 002 review BLOCKER-1/2 resolved (verified: `TODO(task-002-hotfix)` grep
  returns only the review-doc reference, not code).
- 003 review BLOCKER-1/2/3/4 resolved (commit `a0f24d1` message +
  `TODO(task-003-blocker-*)` grep 0 in code).
- Task 009 artefacts merged to `develop` before 010 begins, OR the 010
  branch is cut from `feat/task-009-deploy-automation` so both ship
  together. Implementer decides at scaffold time.

## Design Decisions

### Unread counts — query shape

Single endpoint query per workspace load:

```sql
SELECT
  c.id                         AS channel_id,
  COALESCE(m.count_after, 0)   AS unread_count,
  COALESCE(m.has_mention, false) AS has_mention,
  m.latest_at                  AS last_message_at
FROM channels c
LEFT JOIN user_channel_read_state rs
  ON rs.user_id = :userId AND rs.channel_id = c.id
LEFT JOIN LATERAL (
  SELECT
    count(*)                              AS count_after,
    bool_or(:userId = ANY(msg.mentions))  AS has_mention,
    max(msg.created_at)                   AS latest_at
  FROM messages msg
  WHERE msg.channel_id = c.id
    AND msg.deleted_at IS NULL
    AND (rs.last_read_message_id IS NULL
         OR msg.created_at > rs.last_read_at)
) m ON true
WHERE c.workspace_id = :workspaceId
  AND c.deleted_at IS NULL
  AND (... channel ACL / visibility clause reused from channels.service ...);
```

EXPLAIN gate: index scan on `(channel_id, created_at DESC)` partial
`WHERE deleted_at IS NULL`. If the planner picks a seq scan under any
realistic shape, add the index in a reversible migration (DNA:
migrations reversible-first).

### Observability — rollback counter emission

`scripts/deploy/rollback.sh` doesn't run inside the webhook process, so
it can't `register.inc()` directly. It POSTs to a tiny internal endpoint
(`http://127.0.0.1:<port>/internal/rollback-reported`) that only
accepts 127.0.0.1. The endpoint increments the counter. If the webhook
is down, the rollback still works — metric is fail-open (DNA).

### ESLint palette rule — selector

```js
{
  selector: "Literal[value=/\\b(bg|text|border)-(slate|red|blue|green|yellow)-[0-9]+\\b/]",
  message: "Use design-system semantic tokens (surface, danger, accent, ...) instead of raw Tailwind palette classes.",
}
```

Scoped via `overrides` to the two target trees; warn-only elsewhere for
this task.

## Non-goals

- Rewriting the 008 design system. Only new tokens added if strictly
  required (e.g. `unread-dot`, `unread-dot-mention`).
- Changing the webhook's queue model, HMAC layer, or rollout
  semantics. Observability is additive.
- Backfilling read-state for historical users. New state is created
  on first channel open.

## Risks

- **Reviewer turns up a BLOCKER on 009.** 009 has ~2000 lines of new
  bash + a small Node service. Plausible BLOCKERs: webhook replay
  attack window, race between overlapping redeliveries, the audit log
  being append-only but unbounded, `flock` inheritance across exec
  boundaries. Mitigation: if the fix is >30 minutes, carve into
  `010a-009-hardening.md` and ship separately; keep this task moving
  on B/C/D.
- **Unread query fan-out.** On a workspace with 200 channels the
  `LATERAL` join could blow up. Budget: P95 < 80ms at 200 channels,
  10k messages per channel. Fallback plan: precompute via
  `message.created` WS handler writing to a `unread_cache` Redis hash
  (mentioned in 005's § Design Decisions, deferred then).
- **ESLint palette rule is too noisy to land.** If `apps/web` has >50
  violations outside the two target trees, downgrade to warn-only
  globally and keep error-level only on `features/auth` +
  `features/workspaces`. A broader sweep becomes a later UX task.
- **Rollback callback adds a fail mode.** If the webhook is down during
  a rollback, the metric under-counts. Acceptable; the counter is a
  derived signal, not the rollback mechanism. Runbook already lists
  `docker logs qufox-webhook` as a triage step.
- **Reviewer-subagent spawn for 009 may find `task-009-hotfix` items.**
  These get the same resolution column treatment as the original 003
  review — TODOs numbered in-situ, not deferred further.

## Progress Log

_Implementer fills this section during UNDERSTAND → REPORT, one
bullet per agent-loop stage. See Harness Conventions in CLAUDE.md._

- [ ] UNDERSTAND
- [ ] PLAN approved
- [ ] SCAFFOLD
- [ ] IMPLEMENT (A / B / C / D / E as five commit groups)
- [ ] VERIFY (`pnpm verify` attached)
- [ ] OBSERVE (metrics visible, EXPLAIN checked, E2E traces captured)
- [ ] REFACTOR
- [ ] REPORT (PR body written, reviewer spawned, evals added)
