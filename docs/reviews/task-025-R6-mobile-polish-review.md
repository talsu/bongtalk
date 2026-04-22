# task-025 R6 mobile polish — reviewer audit

Branch: `feat/task-025-mobile-polish-loop`
Base: `0a25e2b` (task-024 merge)
Commits reviewed: 9 (docs + 4 linear follow + 1 harness + 3 R6 polish).

## Summary

R6 ships additively: DS `mobile.css` is untouched; two new CSS files
(`mobile-kb-dodge.css`, `mobile-touch-target.css`) are imported from
`MobileShell.tsx` and carry the keyboard-inset and 44×44 hit-area rules.
6 new `.polish.e2e.ts` harnesses and 1 extension to `composer-send.e2e.ts`
cover all four 024 follow-ups plus the R6 Round fixes. `compose-store`
gains a `replyTargets` record, and the swipe path now rewires directly
to it instead of routing through the sheet. No raw hex, no `rgba()`,
no `[Npx]` Tailwind arbitraries, no `any`. qf-m-\* coverage untouched.
The adversarial read surfaces two harness-quality issues and one minor
memory-map concern — none blocks develop merge.

## BLOCKERs

None.

## HIGH

1. **`touch-target-size.polish.e2e.ts` misses the composer surface it
   was written to guard.** The spec never calls `mobile-topbar-menu` →
   `mobile-channel-general`, so `MobileMessages` never mounts; the only
   interactive elements in-DOM at assertion time are the topbar buttons
   and the tabbar. The exact buttons the accompanying fix
   (`polish-R6-mobile-touch-target`) raises to 44×44 —
   `qf-m-composer__plus`, `qf-m-composer__send`, `mobile-reply-cancel` —
   are never evaluated. The spec therefore green-signals the fix without
   actually exercising it. Fix forward: open the drawer + pick a channel
   before enumerating, and add an explicit long-press→sheet branch so
   the reply item is also sampled.

2. **`drawer-back-button.polish.e2e.ts` assertion contradicts router
   behaviour.** App.tsx uses a splat route `/w/:slug/*`, so
   `page.goBack()` from `/w/{slug}/alpha` → `/w/{slug}` does NOT remount
   `MobileShell`; `leftOpen` state is preserved. The spec opens the
   drawer then calls `goBack()` and expects
   `mobile-left-drawer-root` to have count 0, but nothing closes it on
   URL change. Either the spec was never run against this branch or it
   will flip red on first CI. Fix forward: assert the drawer stays
   open (documenting current behaviour honestly) OR wire a
   `useEffect` in MobileShell that closes both drawers on location
   change and keep the assertion as-is.

## MEDIUM

1. **Future multi-workspace regression in the touch-target spec.**
   `MobileChannelList` renders the workspace rail only when
   `workspaces.length > 1`. Each rail `<Link>` is `p-1` (4px) around a
   24px `qf-avatar--sm`, so width ≈ 32px — below 44. The harness seeds
   exactly one workspace, so this doesn't trip today, but any future
   multi-workspace fixture will. The WHITELIST comment already notes
   this; adding the testid (`mobile-ws-*`) to the whitelist now, or
   growing the rail tile to 44×44, would future-proof the guard.

## LOW / NIT

1. **`replyTargets` map grows monotonically.** `setReplyTarget(ch, null)`
   assigns `undefined` but retains the key. Over a long session with
   many channels this is unbounded in the store shape. Negligible in
   practice (few dozen keys, each tiny); mention only for future
   hygiene — prefer `delete` via a new omit-based setter if it ever
   matters.
2. **VR baselines intentionally deferred to CI.** `follow-3` commits
   only the README; actual PNGs seed on first GHA run. The README is
   explicit about why, matches the 024 risk note, fine.
3. **Potential long-press + past-threshold swipe race** in
   `MobileMessageRow.onTouchEnd`: if both paths fire, the sheet opens
   AND `onSwipeReply()` triggers. The user would see both UIs stacked.
   Needs sustained < 8 px motion for 500 ms then > 80 px lateral drag —
   gymnastic. Optional guard: `if (sheetAlreadyOpen) skip swipe`.
4. **qf-m-composer padding base uses `var(--s-3)` where DS uses literal
   `8px`.** Tokens.css defines `--s-3: 8px`, so the values match today,
   but the divergence means a future `--s-3` retune would silently
   change composer padding. Keeping parity with the DS literal would be
   defensive.

## Verdict

**PASS** — merge to develop.

Both HIGH findings are harness-quality, not correctness of shipped
behaviour: the fixes themselves (keyboard dodge, swipe-reply, scroll
anchor, touch-target CSS, sheet reply item, Tailwind alias rename) are
implemented correctly and consistent with the task contract and DS
source-of-truth rule. The HIGHs should be fixed forward in a R7 or a
short follow-up PR so the R6 guards actually exercise what they claim
to. Nothing here risks the prod deploy; `/readyz` probe and audit-log
gate apply as normal.
