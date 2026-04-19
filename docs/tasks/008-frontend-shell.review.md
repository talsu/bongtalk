# Task 008 — Reviewer Report

Independent review by the general-purpose subagent against
`feat/task-008-frontend-shell`.

## Verdict

**approve-with-comments**. No BLOCKERs — verify is green and architecture
is sound. Two high-risk behavioural items landed on this branch as a
follow-up fix commit (`fix(web): address reviewer ...`); the remaining
non-blocking items are scoped as TODOs.

## Items applied in the follow-up fix commit

1. **Optimistic/realtime duplicate-row race** — `dispatcher.ts`
   `message.created` now collapses any pending optimistic row matching
   `(authorId === 'optimistic' && content === env.message.content)` in
   the same `setQueryData` pass, so a WS broadcast arriving BEFORE the
   HTTP POST response can't leave two rows for one logical message.
2. **Shell-persistence claim** — collapsed the three `/w/:slug…` sibling
   Routes into a single splat Route `/w/:slug/*`. Shell reads the rest
   of the path from `useParams()['*']`. This guarantees React Router
   does not remount the subtree when navigating within the shell.
3. **`qk` drift in `useMessages.ts`** — its inline `keys.list` now
   delegates to `qk.messages.list` so the dispatcher and the hook build
   identical tuples.
4. **Danger toast SR priority** — `Toast.tsx` now emits
   `role="alert" aria-live="assertive"` for `variant='danger'` so
   permission/auth errors interrupt screen-reader speech.

## Deferred non-blocking items

- CommandPalette combobox a11y wiring (role="combobox",
  aria-activedescendant) — TODO.
- Inline submit buttons in ChannelList lack explicit `focus-visible:ring`
  classes; the global `:focus-visible` in index.css still highlights
  them, just inconsistent styling — TODO.
- Pre-existing theme drift in LoginPage/SignupPage/CreateWorkspacePage/
  InviteAcceptPage (hard-coded `slate-*`/`red-*`). NOT introduced here;
  task doc scoped to "authenticated shell" only.
- `useRealtimeConnection` installs a separate `trackId` listener on top
  of the dispatcher — harmless double-subscribe (they do different
  work); consolidating is a nit.

## Reviewer compliments (verbatim)

- "Centralized dispatcher + qk registry + the 'every event has a
  listener' test is exactly the shape that catches drift months later."
- "Trace-bridge pairing (`__trace` captured, stripped from wire
  envelope, `restoreContext` awaited around `emitAsync`) is correct —
  salvage commit is clean."
- "Tokens → CSS vars → tailwind extension pattern is first-class;
  first-paint CSS defaults in `index.css` prevent FOUC;
  prefers-reduced-motion global override catches Radix keyframes."
- "Zustand selectors are scalar; no object-identity re-render traps."
- "Per-chunk bundle budgets with named manual chunks is the right
  'loudly breaks on framework bump' gate."

## Post-fix verification

- `pnpm verify` → 16/16 green
- `pnpm --filter @qufox/web typecheck / test / build / size` pass
- Bundle sizes unchanged by fix commit (all within budget)
