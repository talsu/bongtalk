# Task 025 — 024 Follow Fix + Mobile Polish Loop (Round 6+) → main deploy

## Context

Task 024 shipped mobile shell with 9 chunks all delivered, reviewer
PASS, and real webhook deploy. But the FINAL REPORT surfaced 4
follow-ups — one of which (keyboard dodge) makes the iOS composer
unusable in practice:

- **024-follow-1 (HIGH)**: `useKeyboardDodge` writes
  `--m-kb-inset` CSS variable but no rule reads it → iOS keyboard
  still covers composer
- **024-follow-2**: Swipe-right opens the long-press sheet instead
  of entering reply-mode directly (spec intent)
- **024-follow-3**: VR snapshot baselines missing; first CI run
  needs `--update-snapshots`
- **024-follow-4**: `MobileMessages` auto-scroll jumps during
  history prepend — gate needed on `!isFetchingNextPage`

Task 025 fixes all four in a linear chunk, extends the polish
harness with 6 mobile-specific scenarios (024 is new surface, the
existing 14 harness cover desktop only), and runs the 021/022
loop machinery continuing from Round 6 until convergence.

## Loop structure

Identical to Task 021/022. Round numbering continues:

- 021 used R1–R3 (desktop)
- 022 used R4–R5 (desktop new surfaces)
- 025 starts at **R6** (mobile surfaces)
- Same `polish-backlog.md`, area column (`mobile`) distinguishes

## Scope (IN)

### A. 024 follow-up fix (4 linear commits, before polish loop)

Four commits, one per follow-up, before harness extension or
Round 6 starts.

- **A-1 (024-follow-1)** — Add the CSS rule that consumes
  `--m-kb-inset`. Example (pattern, actual file + selector to be
  confirmed in UNDERSTAND):

  ```css
  .qf-m-composer {
    /* lifted by visualViewport on iOS */
    padding-bottom: calc(env(safe-area-inset-bottom) + var(--m-kb-inset, 0px));
  }
  ```

  File location: options are (a) inline `<style>` block in
  `MobileShell.tsx` (DS mobile.css is untouchable), (b) new
  `apps/web/src/shell/mobile/mobile-kb-dodge.css` imported from
  `MobileShell`. Implementer picks; (b) is cleaner.
  Regression spec: extend
  `apps/web/e2e/mobile/mobile-composer-send.mobile.e2e.ts` with
  a "composer visible with simulated keyboard" assertion.

- **A-2 (024-follow-2)** — `useSwipeHorizontal` currently
  resolves to the same `MobileMessageSheet` as long-press.
  Change: swipe-right bypasses the sheet and sets
  `threadDraftKey` (or the in-channel reply state, depending on
  existing hook) directly, focusing the composer.
  Regression spec: new `mobile-swipe-reply-direct.mobile.e2e.ts`
  (see § B) asserts no sheet appears + composer gets reply UI.

- **A-3 (024-follow-3)** — Run Playwright with
  `--update-snapshots` for `mobile-vr-parity.mobile.e2e.ts`.
  Commit the generated PNG baselines under
  `apps/web/e2e/mobile/mobile-vr-parity.mobile.e2e.ts-snapshots/`.
  First commit includes the PNGs; subsequent runs compare.

- **A-4 (024-follow-4)** — `MobileMessages` auto-scroll
  currently snaps on `wasAtBottomRef` which is still true during
  `fetchNextPage` prepend. Add the `isFetchingNextPage` gate
  (React Query hook state) so scroll only snaps on new-message
  append, not history fetch.
  Regression spec: new `mobile-scroll-prepend.mobile.e2e.ts`
  (see § B).

### B. Mobile harness extension (6 new specs)

`apps/web/e2e/mobile/` gains 6 new specs. Total mobile harness
becomes 7 (existing) + 6 (new) = 13 mobile specs; grand polish
harness 14 desktop + 13 mobile = 27.

- **`mobile-keyboard-dodge.mobile.e2e.ts`**

  - Focus composer → dispatch visualViewport resize (shrink by
    300px simulating keyboard)
  - Assert composer bottom visible (not obscured)
  - Revert viewport → composer returns to resting position
  - Both `iPhone 14` + `Pixel 7` UA configurations

- **`mobile-swipe-reply-direct.mobile.e2e.ts`**

  - Render message row, touch-drag right 60px
  - Assert composer shows "reply-to" UI (or `threadDraftKey`
    state set)
  - Assert `MobileMessageSheet` does NOT render

- **`mobile-scroll-prepend.mobile.e2e.ts`**

  - Seed 30 messages, scroll to top → trigger prepend
  - After prepend completes, assert scroll position is at the
    newly-prepended oldest message (not jumped to bottom)
  - Also: at bottom + new message arrives → auto-snap (ensure
    the fix didn't break the good behavior)

- **`mobile-drawer-back-button.mobile.e2e.ts`**

  - Open left drawer via hamburger
  - Press browser back button
  - Assert drawer closes, URL unchanged
  - Then press back again → normal navigation

- **`mobile-orientation-change.mobile.e2e.ts`**

  - Viewport 375×667 portrait, open channel, scroll to message N
  - Rotate to 667×375 landscape (setViewportSize)
  - Assert same message still visible, composer state preserved
  - Rotate back → same

- **`mobile-touch-target-size.mobile.e2e.ts`**
  - Enumerate every `button`, `a`, `[role="button"]` in
    `qf-m-*` shell
  - Assert `boundingBox` width + height ≥ 44px
  - Skip hidden elements; whitelist for icon-only buttons that
    rely on hit-area padding

### C. Mobile Polish Loop (Round 6+)

Same 8-step loop as 021/022:

1. Discovery — run all 27 polish specs (14 desktop + 13 mobile)
2. Backlog update (status column → `fixed-R6` / `cannot-repro` / etc.)
3. Pick top 6 — prefer `area=mobile` rows when severity is tied
4. Fix + regression test (commit prefix `fix(polish-R<N>-<slug>)`)
5. Reviewer subagent per Round
6. `pnpm verify` green before Round close
7. Progress log in this doc § Rounds
8. Exit check:
   - backlog open CRITICAL+HIGH = 0 → EXIT normal
   - 2 consecutive Rounds 0 new HIGH → EXIT converged
   - Round > R8 (Max 3 in this task) → EXIT cap
   - wall > 3h → EXIT cap
   - user "stop polish" → EXIT user
   - verify red 3× → abort, no merge

### D. develop → main auto-promote + deploy verify

Standard per `feedback_auto_promote_to_main.md`:

1. `git checkout develop && git pull --ff-only && git merge --no-ff feat/task-025-mobile-polish-loop -m "Merge task-025: 024 follow fix + mobile polish loop (Rounds R6..R?)" && git push origin develop`
2. `git checkout main && git pull --ff-only && git merge --no-ff develop -m "Deploy task-025 to prod: mobile polish" && git push origin main`
3. Wait 1–3 min for webhook → auto-deploy
4. Verify `/volume2/dockers/qufox-deploy/.deploy/audit.jsonl`:
   - Last entry `exitCode=0`, sha matches main tip
5. `curl -sk https://qufox.com/api/readyz` → 200
6. idle-window 30s 6 probes all 200

### E. Pane 1 auto-forward (third application)

Per `feedback_pane0_auto_forward_report.md`:

1. Print FINAL REPORT to pane 0
2. Build one-line summary (≤ 600 chars)
3. `printf '%s' '<summary>' > /tmp/task-025-pane1-handoff.txt`
4. `tmux load-buffer /tmp/task-025-pane1-handoff.txt`
5. `tmux paste-buffer -t 7:0.1 -d`
6. `sleep 1 && tmux send-keys -t 7:0.1 Enter`
7. On failure: `[WARN] pane 1 자동 전달 실패: <reason>` in pane 0

## Scope (OUT)

- DM tab actual implementation
- Activity tab actual implementation (mention inbox page)
- FAB / voice
- 021/022's desktop-resolved rows (fixed-R1, fixed-R2, cannot-repro,
  deferred) — untouched unless harness reopens them
- New desktop features

## Acceptance Criteria (mechanical)

- `pnpm verify` green.
- 4 linear follow-fix commits exist with clear messages:
  `fix(mobile-follow-1): ...`, etc.
- 6 new mobile harness specs exist under `apps/web/e2e/mobile/`.
- Round R6+ commits prefixed `fix(polish-R<N>-<slug>)`.
- `docs/polish-backlog.md` extended with new mobile rows (area =
  `mobile`), 021/022 rows intact.
- Reviewer subagent per Round (R6+) with token count recorded.
- 3 artefacts: `025-*.md`, `025-*.PR.md`, `025-*.review.md`
  (aggregate review across Rounds).
- `grep -rn 'fix(mobile-follow' .` returns 4 commits.
- `git log feat/task-025-mobile-polish-loop --oneline | grep 'fix(polish-R[6-9]-'` ≥ 1 commit per Round that did fixes.
- Direct develop merge.
- **develop → main auto-promoted via webhook**.
- `audit.jsonl` last entry `exitCode=0` + sha matches main tip.
- `/readyz` 200 + idle-window 30s verified.
- FINAL REPORT auto-printed + **pane 1 auto-forwarded** (third
  application).
- Feature branch retained.
- FINAL REPORT includes:
  - follow-fix commit table
  - Per-Round commit + reviewer table
  - Backlog snapshot (021/022 preserved, 025 new rows by status)
  - develop SHA, main SHA, exitCode, /readyz, idle-window, wall
  - qf-m-\* usage count (to confirm still-high utilization)

## Prerequisite outcomes

- 024 merged + deployed via webhook (`fc8f425` main).
- `polish-backlog.md` schema stable.
- `apps/web/e2e/polish/` (14 desktop) + `apps/web/e2e/mobile/`
  (7 existing) directories both present.
- `useKeyboardDodge`, `useSwipeHorizontal`, `useLongPress` hooks
  live from 024.
- heartbeat guard from 023 still running (verified by audit.jsonl
  recency).

## Design Decisions

### Same loop machinery, area column for scope

The loop pseudo-code is the same. The only semantic tweak is
that Round 6+ prefers `area=mobile` rows when picking top 6,
because desktop has already converged twice (021/022).

### Round numbering continues from 022

R6 makes `git log --grep 'polish-R6'` a clean selector. Mobile
isn't a different machine; it's the same polish discipline on a
different surface.

### VR baseline seeded in A-3, not during Round

Baselines are infrastructure, not polish. Seeding during a Round
would use the Round's commit slot. Keeping it in the linear
follow-fix section keeps Round 6 focused on actual issues.

### A-3 commits the generated PNGs

~2–4 files, ~400 KB total. Small enough for git. Future
regressions trigger Playwright `toHaveScreenshot` diffs.

### Follow-up fixes before harness extension

A follow-fix 4 are known and scoped. B adds new detectors. C
runs Discovery that includes both the now-fixed follow-up area
(as regression guard) and the newly-added detectors (finding
new issues).

### Max Round 3 (R6~R8)

Mobile is narrower than desktop. 2 polish rounds should converge;
3 is the cap for safety. If R8 still has open HIGH, FINAL REPORT
documents + next task takes over.

## Non-goals

- DMs / Activity / Voice implementation
- Tablet-specific layouts
- Reviewing or changing 021/022 resolved rows
- Polish on desktop surfaces (they're stable)

## Risks

- **visualViewport simulation in Playwright is approximate**.
  Real iOS keyboard behavior may differ. The A-1 fix uses
  real-world `visualViewport.resize` in production; the E2E
  simulates by shrinking the viewport. Acceptable since the code
  path is the same; UA parity probe on real device is manual.
- **Swipe test reliability**. Touch simulation via
  `page.touchscreen` can be flakey. Use explicit duration +
  multiple touch points; if persistently flaky, drop to direct
  `useSwipeHorizontal` unit test.
- **VR baseline drift from platform differences**. GHA runner
  uses Playwright's Chromium container. iPhone SE UA emulation
  approximates; real device differs. Threshold 3% already set in
  024; might need raise to 5% once baseline committed.
- **Round 6 Discovery surfaces a bigger-than-expected backlog**.
  Cap at 6 per Round applies; excess becomes R7 queue.
- **Follow-fix A-1 breaks desktop composer** (unlikely, since
  CSS rule is behind `qf-m-composer` selector). Desktop e2e
  regression guard catches.
- **Orientation change test** relies on `page.setViewportSize`
  without triggering real orientationchange event on all
  browsers. Fallback: use `matchMedia('(orientation: portrait)')`
  mock if native event missing.

## Progress Log

_Implementer fills. Linear follow-fixes in A, then harness
extension in B, then Round loop in C._

- [ ] UNDERSTAND (24 follow-up surfaces, current CSS layers that
      could host the qf-m-composer rule, existing hook shapes,
      VR baseline path)
- [ ] PLAN approved
- [ ] SCAFFOLD (6 new harness specs with failing assertions)
- [ ] A (4 linear follow-fix commits)
- [ ] B (6 harness specs committed, run once to baseline)
- [ ] C Round 6 begins (see § Rounds below)
- [ ] VERIFY (each Round: pnpm verify green)
- [ ] OBSERVE (qf-m-\* count still ≥ 50, VR diffs recorded,
      follow-1 iOS keyboard test proof)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT auto-printed + **pane 1 auto-forwarded**)

## Rounds

_Implementer appends one subsection per Round. Format same as
021/022._

### Round 6

_(not yet run)_

### Round 7

_(not yet run)_

### Round 8

_(not yet run)_

## Final REPORT

_(filled at EXIT)_

- Follow-fix A commits:
- Total Rounds run (R6 through R?):
- Wall clock:
- Exit reason:
- Backlog snapshot (021/022 preserved, 025 rows):
  - Resolved this task: CRITICAL/HIGH/MED/LOW/NIT counts by area
  - Still-open: CRITICAL/HIGH/MED/LOW/NIT counts by area
- develop merge SHA:
- main merge SHA:
- Deploy exitCode:
- /readyz:
- Idle-window verified:
- Deploy duration:
- qf-m-\* usage count:
- Pane 1 auto-forward: success / warning
