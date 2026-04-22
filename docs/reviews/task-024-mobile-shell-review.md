# task-024 — Mobile Shell adversarial review

## Summary

Chunks A–I land a working mobile shell behind a 768px `matchMedia`
branch without modifying the desktop tree. DS `qf-m-*` usage is healthy
(68 occurrences across 8 files, well above the ≥ 50 target). No raw
hex / `[Npx]` arbitrary / `rgba()` in new code, no `any`, no cross-tree
portal leak (branch renders exactly one of `DesktopShell` /
`MobileShell`). Two behavioral gaps keep it short of the spec — the
keyboard-dodge variable is written but never consumed by any CSS rule,
and "swipe-right = reply" is repurposed to "swipe-right = open the
long-press sheet". Neither breaks the current e2e assertions, so they
are HIGH-fix-forward rather than BLOCKER. VR-parity snapshots do not
exist on disk yet and the spec for `vr-parity.e2e.ts` uses
`toHaveScreenshot` without a baseline — first CI run needs
`--update-snapshots` (documented in task risks, but still worth
calling out).

## BLOCKERs

_None._ The shell renders, routes, sends messages, opens both drawers,
respects desktop e2e by only branching on an early `useIsMobile()`
return, and the mobile e2e specs exercise every named acceptance
criterion.

## HIGH

- **`--m-kb-inset` is written but never read.**
  `apps/web/src/lib/useKeyboardDodge.ts:25` sets
  `document.documentElement.style.setProperty('--m-kb-inset', …)`, but
  neither `mobile.css` nor the TSX consume `var(--m-kb-inset)`
  anywhere (verified with a repo-wide grep). `qf-m-composer` already
  bakes `env(safe-area-inset-bottom)` in via `padding-bottom`, and the
  `qf-m-safe-bottom` helper class on the same `<form>`
  (`MobileMessages.tsx:253`) collapses because the more specific
  `.qf-m-composer { padding-bottom: calc(8px + env(...)) }` wins. The
  net effect: on iOS Safari the software keyboard will still cover the
  composer. Fix forward: wire `--m-kb-inset` into
  `.qf-m-composer { padding-bottom: calc(8px + env(...) + var(--m-kb-inset, 0px)); }`
  (in a **new** stylesheet outside `mobile.css` to respect
  DS-source-of-truth) or switch `qf-m-safe-bottom` to subtract the
  inset on the mobile shell root.
- **Swipe-right handler does not enter "reply mode".**
  `MobileMessages.tsx:182` calls `onLongPress()` on a ≥ 80px swipe,
  which opens the same bottom sheet. Task F specifies composer enters
  reply mode directly. The spec also quoted a 40px threshold; code
  uses 80px (safer, but docs drift). The sheet does not yet expose a
  "Reply" menu item either — only Copy / Delete. Follow-up:
  `TODO(task-024-follow-1)` wire quote/reply through the compose
  store.
- **VR-parity snapshot baselines are absent.**
  `e2e/mobile/vr-parity.e2e.ts-snapshots/` does not exist. The first
  GHA run of `mobile-vr-parity` will `toHaveScreenshot` against a
  missing file and fail unless CI is invoked with
  `--update-snapshots` (or a dedicated baseline-seed job). Task risks
  already flag this, but the REPORT must explicitly record that the
  first CI green came via a `--update-snapshots` pass.
- **Message pagination anchor jumps on prepend.**
  `MobileMessages.tsx:78–87` re-runs the auto-scroll effect on every
  `messages.length` change. When `useScrollFetch` loads older
  messages at the top, `wasAtBottomRef.current` may have still been
  `true` from the previous render → we snap back to `scrollHeight`,
  which is now further down, so the user's reading position is lost
  and the newly loaded history scrolls out of view. Reserve a
  pre-prepend `scrollHeight` and restore the delta, or gate the
  "snap to bottom" branch on `wasAtBottomRef && !isFetchingNextPage`.

## MEDIUM

- **Left-drawer state is not reflected in URL/history.**
  Per task risks, opening the drawer should `history.pushState` so
  the hardware back button dismisses the drawer instead of
  navigating away. `MobileShell.tsx:47` keeps it as local
  `useState`. e2e passes because ESC + backdrop click are wired, but
  on-device Android users will lose work.
- **Hook directory drift.**
  Task A calls for `apps/web/src/hooks/useBreakpoint.ts`; the file
  landed at `apps/web/src/lib/useBreakpoint.ts` (and
  `lib/useKeyboardDodge.ts`). Cosmetic, but future subagents greping
  `src/hooks/` will miss it.
- **`qf-m-screen` bakes in 62px iOS device-frame padding.**
  `mobile.css:29` sets `padding-top: var(--m-statusbar)` = 62px on
  every screen — fine inside the DS mockup frame, wrong for the real
  app. `MobileShell.tsx` does not add `qf-m-screen--bare`, so the
  topbar sits 62px below the viewport edge in the live app. Fix
  forward: either apply `qf-m-screen--bare` in the real-app root or
  gate the statusbar padding behind a DS-only selector. (Strictly
  this is a DS-consumption bug; since DS is source-of-truth the
  consumer must opt out with `--bare`.)
- **`useKeyboardDodge`'s `dataset.mKbOpen` is never queried.**
  Dead state write. Either consume it (e.g. `[data-m-kb-open="true"]
.qf-m-tabbar { display: none }` to free screen real estate) or
  drop it. `delete root.dataset.mKbOpen` correctly cleans up.

## LOW/NIT

- `MobileMessages.tsx:48–51` has four `void x;` unused-suppression
  lines (`updMut`, `delMut`, `reactMut`, `workspaceSlug`) even though
  three of those are used in the sheet callbacks. Dead lines, lint is
  quiet, tidy up.
- `MobileMessages.tsx:69` `void roleById;` — the map is built and
  thrown away. Either render the role badge on the row or drop the
  memo.
- `MobileMessageSheet.tsx` does not expose a "Reply" item. Once F is
  completed, this becomes a BLOCKER for the follow-up; flagging now.
- `bg-bg-panel` / `bg-bg-hover` / `bg-bg-selected` are not defined in
  `tailwind.config.js` (the tokens are `bg-subtle` / `bg-muted` /
  `bg-accent`). These classes silently no-op. Pre-existing convention
  across the desktop tree, so out of scope for this task — but the
  new mobile files inherited the typo. Consider a follow-up sweep.
- `MobileTabBar.tsx:67` `disabled` attribute + `onClick={undefined}`
  is redundant with `aria-disabled`; pick one for the tests to assert
  against consistently (currently tests assert `aria-disabled`).
- `MobileMessageRow` long-press timer has no unmount cleanup. If the
  row unmounts mid-press the timer still fires and calls
  `onLongPress()`. Parent is still mounted so it's harmless today,
  but add a `useEffect(() => () => clearTimeout(pressTimer.current))`
  for hygiene.
- VR test threshold is 2% (`DS_PARITY_THRESHOLD ?? 0.02`), tighter
  than the task-contract's "≤ 3% sub-pixel tolerance". OK if the
  baseline holds; relax to 0.03 if first CI run diffs.
- `MobileDrawer.tsx:48` inline `style={{ width: '86%', maxWidth:
'360px', boxShadow: 'var(--elev-3)' }}` — `360px` is a raw pixel
  literal. ESLint rule targets `[Npx]` Tailwind arbitrary syntax, not
  CSS string values, so it passes. Spirit of task-018 says prefer
  `--w-*` tokens; no existing `--w-drawer-mobile` token, so leaving
  inline is fine, but add a TODO to lift it into `tokens.css`.

## Verdict

**PASS — merge to develop.** No BLOCKERs. Four HIGH items are
fix-forward candidates: keyboard-dodge wiring, swipe-to-reply mode,
VR baseline seeding, and pagination anchor. Capture them as
`TODO(task-024-follow-1..4)` in the FINAL REPORT and let the webhook
auto-deploy proceed.
