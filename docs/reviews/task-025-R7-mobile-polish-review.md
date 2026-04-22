# task-025 R7 mobile polish — reviewer re-read

**Branch:** `feat/task-025-mobile-polish-loop`
**HEAD:** `7d91170 fix(polish-R7-mobile-harness-gaps): close drawer on route change + make touch-target spec actually run`
**Scope:** Fix-forward on two harness-quality HIGHs from R6 review. Diff = 4 files, +73/-21.

## Verdict: **PASS**

Narrow, well-scoped fix. No BLOCKER / HIGH / MED findings.

## Checks

1. **`location.pathname` effect on first mount** — fires once with `leftOpen === false`; no visible effect. Safe.
2. **Drawer intent across route change** — per-screen modal semantics. No surface in mobile shell is supposed to persist the drawer across navigation, so the blanket reset is correct.
3. **Spec-to-code coupling** — if the `useEffect` in MobileShell regressed, the channel-pick assertion (`expect(mobile-left-drawer-root).toHaveCount(0)` after `/w/<slug>/alpha`) would fail because `onPick` alone flips `leftOpen` before the navigate lands — except now the effect re-enforces it on the pathname change. The back-button path (`goBack()` from `/w/<slug>/alpha` → `/w/<slug>`) is only covered by the pathname effect, so the spec genuinely guards the new code.
4. **testid wiring verified** — `mobile-left-drawer-root`, `mobile-left-drawer-backdrop` emitted by MobileDrawer (`${testId}-root`, `${testId}-backdrop`); `mobile-msg-sheet-*` + `mobile-channel-<name>` + `mobile-composer-send` + `mobile-msg-input` all exist. `data-mine="true"` row selector matches MobileMessages line 243.
5. **DS / purity** — no raw hex, no `rgba(`, no `[Npx]` arbitrary, no `any`. The one `768px` hit is inside a JSDoc comment, not shipped CSS. DS `mobile.css` untouched (prior R6 discipline held).
6. **Backlog hygiene** — `mobile-drawer-no-back-dismiss` deferred → fixed-R7 with rationale (simpler than history.pushState). New row `mobile-touch-target-spec-vacuous` fixed-R7 documents the vacuous-pass gap honestly.

## Nits (non-blocking)

- The touch-target spec's `waitForTimeout(650)` for long-press is a timing coupling (long-press threshold is ~500ms); acceptable for a polish harness, but if the threshold ever drops this will flake in the other direction. Low risk.
- `drawer-back-button` spec relies on `goBack()` landing at `/w/<slug>` — true because login drops the user there pre-channel-pick. If login ever lands directly on a channel, the back step would exit the SPA; not worth preempting.

## Signal

Fix targets exactly the two R6 HIGHs (drawer-back semantics + vacuous-pass guard) and nothing else. Cap respected. Cleared for develop merge.
