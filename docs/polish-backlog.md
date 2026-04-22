# Polish Backlog

Managed by Task 021+. Source of truth for polish Round selection.

## Columns

- `id` — stable identifier, kebab-case
- `severity` — CRITICAL | HIGH | MED | LOW | NIT
- `area` — realtime | ui | data | perf | a11y | backend
- `title` — one-line summary
- `repro` — shortest path to reproduce
- `candidate-fix` — one-line guess at the fix
- `status` — open | in-progress-R<N> | fixed-R<N> | cannot-repro | deferred
- `detected` — Round number first seen (`INIT` for harness seed)
- `resolved` — Round number closed (empty if still open)
- `notes` — optional context / reviewer quotes / references

## Rows

| id                                    | severity | area     | title                                                                        | status       | detected | resolved | notes                                                                                                                                                                                                                                                                         |
| ------------------------------------- | -------- | -------- | ---------------------------------------------------------------------------- | ------------ | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ime-enter-half-sends                  | HIGH     | ui       | Pressing Enter during Korean IME composition sends the half-formed text      | fixed-R1     | INIT     | R1       | MessageComposer + ThreadPanel both guard on nativeEvent.isComposing / keyCode 229; harness ime-composition.polish.e2e.ts asserts no POST during composition                                                                                                                   |
| typing-stale-on-clear                 | HIGH     | realtime | Typing indicator hangs up to 5s after the user deletes all text              | fixed-R1     | INIT     | R1       | New WS event typing.stop + TypingService.stop SREM + throttle DEL; client fires on empty draft + on submit                                                                                                                                                                    |
| typing-stale-on-tab-close             | HIGH     | realtime | Typing indicator lingers after tab close / network drop                      | deferred     | INIT     |          | 018-F disconnect hook already SREMs + re-broadcasts; harness typing-accuracy.polish.e2e.ts second scenario asserts ≤7s                                                                                                                                                        |
| presence-lag-on-disconnect            | HIGH     | realtime | Presence offline flip on force-close bounded by session TTL                  | deferred     | INIT     |          | 005 disconnect hook fires immediately + presence throttler broadcasts within 2s; harness asserts ≤10s. True <5s guarantee requires shorter TTL — out of polish scope                                                                                                          |
| unread-sidebar-lag                    | HIGH     | realtime | Sidebar unread dot sometimes delays > 2s after cross-channel message         | deferred     | INIT     |          | Dispatcher already invalidates unread-summary + workspace-totals; harness asserts ≤2.5s as regression guard                                                                                                                                                                   |
| scroll-jumps-on-new-message           | HIGH     | ui       | New message arrival can yank scroll position                                 | fixed-R1     | INIT     | R1       | Root cause: nearBottom checked post-append on grown scrollHeight. Fix: wasAtBottomRef stamped on scroll events; useLayoutEffect consults ref post-append                                                                                                                      |
| reaction-flicker-own-toggle           | MED      | ui       | Own-reaction pill briefly disappears between optimistic + WS echo            | cannot-repro | INIT     | R1       | upsertReactionBucket preserves byMe when mineChanges=true; onMutate sets byMe=true optimistically; harness samples 40× over 2s — reopen if harness fails in Round 2                                                                                                           |
| ime-edit-half-saves                   | HIGH     | ui       | Pressing Enter mid-IME-composition in message edit saves half-syllable       | fixed-R2     | R2       | R2       | Same root cause as R1 ime-enter-half-sends — MessageItem.tsx edit input lacked the guard. Fix mirrors MessageComposer / ThreadPanel; regression harness extends ime-composition.polish.e2e.ts                                                                                 |
| ime-palette-half-runs                 | HIGH     | ui       | Ctrl+K palette Enter mid-composition fires first filtered action             | fixed-R2     | R2       | R2       | Same IME guard family in CommandPalette.tsx onKeyDown; harness extends ime-composition.polish.e2e.ts with palette scenario (URL unchanged + input still visible)                                                                                                              |
| composer-upload-error-state-missing   | HIGH     | ui       | Upload failures fall silent / chip disappears with no toast                  | fixed-R4     | R4       | R4       | R4 Discovery confirmed: failed upload chips were filtered out after a toast. Fix: track jobs with status uploading/failed, failed chips persist with retry button + close. Harness regression asserts data-status=failed + retry click transitions to pending-attachment row. |
| composer-autogrow-cap-missing         | MED      | ui       | Composer grows without ceiling when pasted text exceeds typical viewport     | cannot-repro | R4       | R4       | R4 Discovery: MessageComposer.tsx correctly clamps via Math.min(MAX_HEIGHT_PX=200, Math.max(MIN, scrollHeight)). Harness composer-autogrow.polish.e2e.ts keeps the regression guard live.                                                                                     |
| thread-panel-draft-loss               | HIGH     | ui       | Typed thread draft discarded on panel close/reopen                           | fixed-R4     | R4       | R4       | R4 Discovery confirmed: ReplyComposer held draft in local useState, lost on unmount. Fix: route through compose-store under threadDraftKey(rootId). Harness asserts draft preserved after close → reopen via URL reload.                                                      |
| settings-overlay-esc-palette-conflict | MED      | a11y     | ESC with overlay open may bubble to palette / shell routes                   | cannot-repro | R4       | R4       | R4 Discovery: Radix Dialog stops Escape propagation by default; useShortcut's global keydown handler isn't reached when a Radix dialog is the focused layer. Verified via reviewer audit.                                                                                     |
| settings-overlay-backdrop-click       | MED      | ui       | Outside click on settings overlay incorrectly closes stacked dialog too      | cannot-repro | R4       | R4       | R4 Discovery: Radix Dialog's onInteractOutside dismisses only the topmost layer. Stacked dialog + settings behave correctly.                                                                                                                                                  |
| channel-settings-save-echo-lag        | MED      | realtime | Channel name/topic save doesn't propagate within 2s to channel list / topbar | cannot-repro | R4       | R4       | R4 Discovery: useUpdateChannel onSuccess invalidates the channel list query; channel-settings-screen harness asserts topbar topic updates within 5s. Architecturally sound.                                                                                                   |
| members-modal-keyboard-nav            | MED      | a11y     | Tab order inside members modal not reliably focusable                        | cannot-repro | R4       | R4       | R4 Discovery: Radix Dialog focus trap auto-focuses first interactive; members-modal harness asserts Tab lands on BUTTON/SELECT/INPUT within the modal.                                                                                                                        |
| channel-dnd-permission-feedback       | HIGH     | a11y     | MEMBER sees no visual cue that DnD is unavailable (cursor still grab?)       | cannot-repro | R4       | R4       | R4 Discovery: earlier polish round (2f79fef/aed63c5) already set cursor-pointer for non-managers and hides the gear button entirely. channel-dnd-permission harness asserts both. No additional UX signal needed.                                                             |
| channel-dnd-cross-category-drop       | MED      | ui       | Cross-category drop insertion landing sometimes off by one                   | cannot-repro | R4       | R4       | R4 Discovery: ChannelList.handleDragEnd cross-section branch uses `insertAt = overIdx >= 0 ? overIdx : targetList.length` with proper beforeId/afterId resolution.                                                                                                            |
| inline-search-keyboard-nav            | HIGH     | a11y     | Arrow keys don't wrap; Enter on empty highlight does nothing                 | cannot-repro | R4       | R4       | R4 Discovery: SearchInput clamps arrow nav with Math.min/max (no wrap, by design — matches Slack/Discord); Enter on empty results gracefully no-ops (no crash). Reclassified as acceptable behaviour, not a bug.                                                              |
| inline-search-old-route-leak          | MED      | cleanup  | Legacy /search route or SearchOverlay testid lingers                         | cannot-repro | R4       | R4       | R4 Discovery: grep src/e2e — SearchOverlay.tsx already deleted in 4e0caf8, no dead references. search-input testid only appears in the current SearchInput.tsx (matches the e2e assertion).                                                                                   |

## Status summary (Round 4 close)

| Severity | Open | In-progress | Fixed | Cannot-repro | Deferred |
| -------- | ---- | ----------- | ----- | ------------ | -------- |
| CRITICAL | 0    | 0           | 0     | 0            | 0        |
| HIGH     | 0    | 0           | 7     | 3            | 3        |
| MED      | 0    | 0           | 0     | 6            | 0        |
| LOW      | 0    | 0           | 0     | 0            | 0        |

Totals across tasks 021 + 022 after R4 close: 0 open, 7 HIGH fixed,
3 HIGH cannot-repro (reclassified this round), 3 HIGH deferred
(harness-as-guard). 6 MED cannot-repro (1 from 021, 5 from 022 R4).

Round 4 Discovery audit via reviewer subagent confirmed 2 real
HIGH bugs (both fixed this round) and reclassified the remaining
9 seed rows as cannot-repro or acceptable-behaviour. The polish
harness for those rows stays live as regression guard — if any
spec turns red in a future Round, the corresponding row reopens.

## Round summaries

See `docs/tasks/021-polish-loop.md` § Rounds for R1–R3,
`docs/tasks/022-polish-loop-2.md` § Rounds for R4+.
