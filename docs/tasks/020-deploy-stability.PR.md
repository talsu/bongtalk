# Task 020 PR — Deploy Stability (outbox idle/stalled + Dockerfile chmod + E2E race fix)

**Branch:** `feat/task-020-deploy-stability`
**Base:** `develop` (at branch-out) / heads to main via auto-promote
**Merge style:** direct `git merge --no-ff` to develop + develop → main auto-promotion (second application of `feedback_auto_promote_to_main.md`)
**Memory norms:** `feedback_design_system_source_of_truth.md`, `feedback_polite_korean.md`, `feedback_minio_naming.md`, `feedback_retain_feature_branches.md`, `feedback_handoff_must_include_report.md`, `feedback_auto_promote_to_main.md`

## Summary

Three surgical fixes for pipeline issues 019 surfaced. No features.

- **A — Outbox idle vs stalled** · `OutboxHealthIndicator` discriminator is now "undispatched rows older than threshold" rather than "no dispatch tick in threshold". Idle windows (empty outbox, quiet dispatcher) → 200 `"idle"`. Stalled (backlog > 0 + no tick) → 503 `"stalled"` with row count in the detail. Prometheus `OutboxDispatcherStalled` alert rewritten to AND the last-tick clause with `outbox_pending_events > 0`.
- **B — api Dockerfile chmod + CI umask smoke** · `apps/api/Dockerfile` runtime stage gains `RUN chmod -R a+rX /app` mirroring the 019 web hotfix. New `scripts/deploy/tests/dockerfile-umask-smoke.sh` rebuilds both images under `umask 0077 --no-cache` then probes every regular file for the world-read bit. Wired into `.github/workflows/integration.yml` as a dedicated `docker-umask-smoke` job + surfaced via `pnpm docker:build:smoke` root script.
- **C — notification-settings e2e race** · explicit `page.waitForResponse('/me/notification-preferences', method: GET, status: 200)` between navigation and first radio click. Sibling audit of `apps/web/e2e/**` turned up no other settings-style specs with the same shape.

## Acceptance

```
$ grep -rn 'TODO(task-019-follow-1\|TODO(task-019-follow-2\|TODO(task-019-follow-3' --include='*.ts' --include='*.tsx' --include='*.sh' .
0 lines
```

## Verify (local)

```
@qufox/api:typecheck  ✓
@qufox/api:test       ✓ 64/64 (+1 new idle-state health.spec case)
@qufox/web:typecheck  ✓
@qufox/web:lint       ✓ 0 errors (43 pre-existing warnings)
@qufox/web:test       ✓ 36/36
@qufox/web:build      ✓ Shell ~19 KB gzip
bash -n on scripts/deploy/tests/dockerfile-umask-smoke.sh  ✓
```

Integration + Playwright + docker-umask-smoke are exercised on GHA:

- `apps/api/test/int/observability/outbox-health-idle-vs-stalled.int.spec.ts` (3 cases)
- `apps/api/test/int/observability/health.degraded.int.spec.ts` (updated to drive backlog-based stale)
- `apps/web/e2e/shell/notification-settings.e2e.ts` (race-fix landed)
- `docker-umask-smoke` workflow job

## New artefacts

- `docs/tasks/020-deploy-stability.md`
- `docs/tasks/020-deploy-stability.PR.md` (this file)
- `docs/tasks/020-deploy-stability.review.md`
- `evals/tasks/036-outbox-health-idle-vs-stalled.yaml`

## Commits

```
801e4e6 docs(task-020): deploy stability task contract
bb57133 feat(task-020-A): OutboxHealthIndicator idle vs stalled (backlog discriminator)
79501b0 feat(task-020-B): apps/api/Dockerfile chmod + docker-umask-smoke CI + pnpm script
12a81d0 fix(task-020-C): notification-settings e2e race — waitForResponse on prefs GET
```

## Idle-window verification (planned)

Right after the main auto-promote finishes, curl `/readyz` in a brief
loop with no traffic generated. Old pipeline: 503 within 10–15s of the
health-wait's last tick. New pipeline: 200 throughout. Result noted in
the REPORT.

## Deferred

Reviewer findings populate `TODO(task-020-follow-*)` entries post
round 1 if any remain after the fix-forward.
