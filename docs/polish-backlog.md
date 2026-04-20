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

| id                          | severity | area     | title                                                                   | status       | detected | resolved | notes                                                                                                                                                                |
| --------------------------- | -------- | -------- | ----------------------------------------------------------------------- | ------------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ime-enter-half-sends        | HIGH     | ui       | Pressing Enter during Korean IME composition sends the half-formed text | fixed-R1     | INIT     | R1       | MessageComposer + ThreadPanel both guard on nativeEvent.isComposing / keyCode 229; harness ime-composition.polish.e2e.ts asserts no POST during composition          |
| typing-stale-on-clear       | HIGH     | realtime | Typing indicator hangs up to 5s after the user deletes all text         | fixed-R1     | INIT     | R1       | New WS event typing.stop + TypingService.stop SREM + throttle DEL; client fires on empty draft + on submit                                                           |
| typing-stale-on-tab-close   | HIGH     | realtime | Typing indicator lingers after tab close / network drop                 | deferred     | INIT     |          | 018-F disconnect hook already SREMs + re-broadcasts; harness typing-accuracy.polish.e2e.ts second scenario asserts ≤7s                                               |
| presence-lag-on-disconnect  | HIGH     | realtime | Presence offline flip on force-close bounded by session TTL             | deferred     | INIT     |          | 005 disconnect hook fires immediately + presence throttler broadcasts within 2s; harness asserts ≤10s. True <5s guarantee requires shorter TTL — out of polish scope |
| unread-sidebar-lag          | HIGH     | realtime | Sidebar unread dot sometimes delays > 2s after cross-channel message    | deferred     | INIT     |          | Dispatcher already invalidates unread-summary + workspace-totals; harness asserts ≤2.5s as regression guard                                                          |
| scroll-jumps-on-new-message | HIGH     | ui       | New message arrival can yank scroll position                            | fixed-R1     | INIT     | R1       | Root cause: nearBottom checked post-append on grown scrollHeight. Fix: wasAtBottomRef stamped on scroll events; useLayoutEffect consults ref post-append             |
| reaction-flicker-own-toggle | MED      | ui       | Own-reaction pill briefly disappears between optimistic + WS echo       | cannot-repro | INIT     | R1       | upsertReactionBucket preserves byMe when mineChanges=true; onMutate sets byMe=true optimistically; harness samples 40× over 2s — reopen if harness fails in Round 2  |

## Status summary (Round 1 close)

| Severity | Open | In-progress | Fixed | Cannot-repro | Deferred |
| -------- | ---- | ----------- | ----- | ------------ | -------- |
| CRITICAL | 0    | 0           | 0     | 0            | 0        |
| HIGH     | 0    | 0           | 3     | 0            | 3        |
| MED      | 0    | 0           | 0     | 1            | 0        |
| LOW      | 0    | 0           | 0     | 0            | 0        |

Three HIGH rows are `deferred` because the backend plumbing from 005 / 018-F already
implements the correct SLA behavior; the polish-harness specs serve as live regression
guards rather than motivating new code. If any harness spec turns red in a future
Round's Discovery, the corresponding row reopens.

## Round summaries

See `docs/tasks/021-polish-loop.md` § Rounds for per-round detail.
