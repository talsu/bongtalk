# task-039 Hot-fix Recovery & Deferred Sweep — Adversarial Review

## Verdict

**APPROVE WITH FIXES.** No code-correctness BLOCKERs in shipped
product code (only behaviour delta — `INVALID_MAGIC_BYTES` 400→422 —
is local). The new fixture script is broken (HIGH-1) and the prod
script's silent fallback is unsafe (HIGH-2). Fix forward before merge.

## BLOCKER

_None._

## HIGH

**HIGH-1 — Fixture cannot reach the assertion it makes.**
`scripts/backup/test/orphan-gc-pagination.test.sh:51-53` invokes the
production script with `DATABASE_URL=postgres://stub:stub@localhost:1/stub`.
That value is non-empty, so it bypasses the `--dry-run`-without-env
early exit at `attachment-orphan-gc.sh:47-51`. Control falls through
to `CANDIDATES=$(psql "$PGURL" -At ...)` at `:66`. Under `set -euo
pipefail`, a failed command-substitution aborts the script — psql
against `localhost:1` is `connection refused` (exit 2). The script
exits **before** the emoji sweep runs, so the `emoji dry-run:
scanned=N` line the fixture greps for at `:58` is never emitted, and
the test fails with `scanned=?`. Confirmed: `RESULT=$(false)` under
`set -e` exits 1. **Fix:** point `DATABASE_URL` at a live throwaway pg
container, or short-circuit the psql call when the prod script
detects a stub URL in dry-run.

**HIGH-2 — `|| echo '{}'` in pagination loop silently swallows AWS
errors.**
`attachment-orphan-gc.sh:175-184` wraps both `list-objects-v2` calls
in `|| echo '{}'`. On any transient AWS/MinIO failure the parser sees
empty `Contents`, sets `TOKEN=""`, and the loop terminates with
`emoji ok: scanned=0 deleted=0` — no warning. A failure on **page 4
of 5** silently truncates the scan and leaves real orphans behind
while the daily summary looks healthy. **Fix:** capture the AWS
exit-code and `log "(warn) ..."` then `break` (fail-soft) or `exit 2`
(fail-loud). Silent swallow is not acceptable for a GC sweep.

## MED

**MED-1 — `[403, 404]` accept-set is over-permissive.**
`apps/api/test/int/dms/dm-workspaceless-message.int.spec.ts:82` should
lock to 403. `DmChannelAccessGuard` deterministically throws
`CHANNEL_NOT_VISIBLE` (403) for non-participants on a live DIRECT
channel (`apps/api/src/messages/guards/dm-channel-access.guard.ts:60`).
404 only fires if the channel were deleted, which the test doesn't do.

**MED-2 — Mobile DM e2e omits the reload-history step.**
`apps/web/e2e/dms/dm-workspaceless-flow.e2e.ts:85-110` send-then-assert
on mobile but never reloads. The desktop branch at `:79` does. The
mobile path is precisely what hot-fix `c5146ff` (DM history enabled
gate for null workspaceId) addressed. Add `await page.reload()` +
re-assert.

**MED-3 — Stale "400 INVALID_MAGIC_BYTES" comment.**
`apps/api/src/emojis/custom-emoji.service.ts:169` still says "400" in
the explanatory comment. Status is now 422 per `error-code.enum.ts:157`.

## LOW

**LOW-1 — Trap won't fire on SIGKILL** in
`orphan-gc-pagination.test.sh:29`. SIGTERM / SIGINT / normal exit all
clean up; `kill -9` leaks the `__pagination-test-<stamp>__/` prefix.
Acceptable: fixture prefix cannot collide with workspace UUIDs (v4 has
no leading underscore).

**LOW-2 — boundingBox.y order assertion fragile under flex/grid.**
`workspace-create-dialog.e2e.ts:50-56`: if a redesign places fields
side-by-side, `nameY < slugY` becomes a tautology. Currently fields
stack vertically per `CreateWorkspaceDialog.tsx`, so it holds today.

**LOW-3 — 1500 sequential `aws s3 cp` calls** take minutes on the
NAS, not the ~30s claimed at `orphan-gc-pagination.test.sh:31`. Use
`aws s3 sync` or update the estimate.

## OK

- `INVALID_MAGIC_BYTES` 400→422: only API code references it. Web
  client / monitoring / contract tests don't pin 400. Int specs assert
  on `code:` not status (`magic-bytes-attachment.int.spec.ts:137`,
  `magic-bytes-emoji.int.spec.ts:128`).
- `dm-realtime-fanout.e2e.ts:77,83` 10s timeout matches realtime
  convention (`unread-propagation.e2e.ts:104,133`).
- `discover-three-column-layout.e2e.ts` mobile `count(0)` holds —
  `App.tsx:161` swaps `MobileDiscover` for `DiscoverShell`, and
  `MobileDiscover` doesn't render `workspace-nav` / `discover-side`.
- `zero-workspace-landing.e2e.ts` `waitForURL('**/dm')` handles the
  post-login redirect race.
- `home-dm-brand-mark-fold.e2e.ts` aria-label `메세지` matches
  `WorkspaceNav.tsx:35`.
- All `data-testid` references in new specs verified present in
  `apps/web/src` (`dm-shell-root`, `dm-side-friend-*`, `msg-column-*`,
  `mobile-dm-*`, `discover-*`, `ws-*`).
- DS source-of-truth: no token / component churn this task.

## Required before merge

1. HIGH-1 — fix fixture so the emoji sweep actually runs.
2. HIGH-2 — replace silent `|| echo '{}'` with explicit warn.
3. MED-1 / MED-2 / MED-3 — small token edits.
