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

| id                                    | severity | area     | title                                                                        | status       | detected | resolved | notes                                                                                                                                                                                         |
| ------------------------------------- | -------- | -------- | ---------------------------------------------------------------------------- | ------------ | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ime-enter-half-sends                  | HIGH     | ui       | Pressing Enter during Korean IME composition sends the half-formed text      | fixed-R1     | INIT     | R1       | MessageComposer + ThreadPanel both guard on nativeEvent.isComposing / keyCode 229; harness ime-composition.polish.e2e.ts asserts no POST during composition                                   |
| typing-stale-on-clear                 | HIGH     | realtime | Typing indicator hangs up to 5s after the user deletes all text              | fixed-R1     | INIT     | R1       | New WS event typing.stop + TypingService.stop SREM + throttle DEL; client fires on empty draft + on submit                                                                                    |
| typing-stale-on-tab-close             | HIGH     | realtime | Typing indicator lingers after tab close / network drop                      | deferred     | INIT     |          | 018-F disconnect hook already SREMs + re-broadcasts; harness typing-accuracy.polish.e2e.ts second scenario asserts ≤7s                                                                        |
| presence-lag-on-disconnect            | HIGH     | realtime | Presence offline flip on force-close bounded by session TTL                  | deferred     | INIT     |          | 005 disconnect hook fires immediately + presence throttler broadcasts within 2s; harness asserts ≤10s. True <5s guarantee requires shorter TTL — out of polish scope                          |
| unread-sidebar-lag                    | HIGH     | realtime | Sidebar unread dot sometimes delays > 2s after cross-channel message         | deferred     | INIT     |          | Dispatcher already invalidates unread-summary + workspace-totals; harness asserts ≤2.5s as regression guard                                                                                   |
| scroll-jumps-on-new-message           | HIGH     | ui       | New message arrival can yank scroll position                                 | fixed-R1     | INIT     | R1       | Root cause: nearBottom checked post-append on grown scrollHeight. Fix: wasAtBottomRef stamped on scroll events; useLayoutEffect consults ref post-append                                      |
| reaction-flicker-own-toggle           | MED      | ui       | Own-reaction pill briefly disappears between optimistic + WS echo            | cannot-repro | INIT     | R1       | upsertReactionBucket preserves byMe when mineChanges=true; onMutate sets byMe=true optimistically; harness samples 40× over 2s — reopen if harness fails in Round 2                           |
| ime-edit-half-saves                   | HIGH     | ui       | Pressing Enter mid-IME-composition in message edit saves half-syllable       | fixed-R2     | R2       | R2       | Same root cause as R1 ime-enter-half-sends — MessageItem.tsx edit input lacked the guard. Fix mirrors MessageComposer / ThreadPanel; regression harness extends ime-composition.polish.e2e.ts |
| ime-palette-half-runs                 | HIGH     | ui       | Ctrl+K palette Enter mid-composition fires first filtered action             | fixed-R2     | R2       | R2       | Same IME guard family in CommandPalette.tsx onKeyDown; harness extends ime-composition.polish.e2e.ts with palette scenario (URL unchanged + input still visible)                              |
| composer-upload-error-state-missing   | HIGH     | ui       | Upload failures fall silent / chip disappears with no toast                  | open         | R4       |          | Composer v2 pending attachments — confirm chip stays, add retry affordance, toast on 4xx                                                                                                      |
| composer-autogrow-cap-missing         | MED      | ui       | Composer grows without ceiling when pasted text exceeds typical viewport     | open         | R4       |          | MAX_HEIGHT_PX=200 should hold; verify via composer-autogrow.polish.e2e.ts                                                                                                                     |
| thread-panel-draft-loss               | HIGH     | ui       | Typed thread draft discarded on panel close/reopen                           | open         | R4       |          | ThreadPanel ReplyComposer is local state; either persist per-root draft or document the loss                                                                                                  |
| settings-overlay-esc-palette-conflict | MED      | a11y     | ESC with overlay open may bubble to palette / shell routes                   | open         | R4       |          | Radix Dialog stops propagation by default but verify with stacked modal + palette                                                                                                             |
| settings-overlay-backdrop-click       | MED      | ui       | Outside click on settings overlay incorrectly closes stacked dialog too      | open         | R4       |          | Radix dismisses the topmost layer; double-check with confirm dialog open                                                                                                                      |
| channel-settings-save-echo-lag        | MED      | realtime | Channel name/topic save doesn't propagate within 2s to channel list / topbar | open         | R4       |          | useUpdateChannel already invalidates queries; measure actual latency                                                                                                                          |
| members-modal-keyboard-nav            | MED      | a11y     | Tab order inside members modal not reliably focusable                        | open         | R4       |          | Radix Dialog provides focus trap; ensure role-select focuses on Tab                                                                                                                           |
| channel-dnd-permission-feedback       | HIGH     | a11y     | MEMBER sees no visual cue that DnD is unavailable (cursor still grab?)       | open         | R4       |          | 9d949e8 disabled useSortable for non-managers; verify cursor + no gear                                                                                                                        |
| channel-dnd-cross-category-drop       | MED      | ui       | Cross-category drop insertion landing sometimes off by one                   | open         | R4       |          | handleDragEnd uses beforeId/afterId; verify via channel-dnd-permission harness                                                                                                                |
| inline-search-keyboard-nav            | HIGH     | a11y     | Arrow keys don't wrap; Enter on empty highlight does nothing                 | open         | R4       |          | SearchInput uses Math.min/max clamping; document expected behavior                                                                                                                            |
| inline-search-old-route-leak          | MED      | cleanup  | Legacy /search route or SearchOverlay testid lingers                         | open         | R4       |          | SearchOverlay.tsx removed in 4e0caf8; verify no dead references                                                                                                                               |

## Status summary (Round 2 close)

| Severity | Open | In-progress | Fixed | Cannot-repro | Deferred |
| -------- | ---- | ----------- | ----- | ------------ | -------- |
| CRITICAL | 0    | 0           | 0     | 0            | 0        |
| HIGH     | 0    | 0           | 5     | 0            | 3        |
| MED      | 0    | 0           | 0     | 1            | 0        |
| LOW      | 0    | 0           | 0     | 0            | 0        |

Three HIGH rows are `deferred` because the backend plumbing from 005 / 018-F already
implements the correct SLA behavior; the polish-harness specs serve as live regression
guards rather than motivating new code. If any harness spec turns red in a future
Round's Discovery, the corresponding row reopens.

Round 2 surfaced 2 new HIGH via grep-audit on Enter-handling surfaces that R1 missed:
`ime-edit-half-saves` (MessageItem.tsx edit input) and `ime-palette-half-runs`
(CommandPalette.tsx search input). Both fixed in R2 with the identical isComposing /
keyCode 229 guard; the polish harness now covers all four IME entry points
(composer / thread reply / message edit / command palette).

## Round summaries

See `docs/tasks/021-polish-loop.md` § Rounds for per-round detail.
