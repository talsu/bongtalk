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

| id                          | severity | area     | title                                                                      | repro                                                                                    | candidate-fix                                                                                              | status | detected | resolved | notes                                                             |
| --------------------------- | -------- | -------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ | -------- | -------- | ----------------------------------------------------------------- |
| ime-enter-half-sends        | HIGH     | ui       | Pressing Enter during Korean IME composition sends the half-formed text    | compose `한` (ㅎ+ㅏ+ㄴ), hit Enter mid-composition → message shows `하` or `ㅎ`          | `onKeyDown` branch on `e.nativeEvent.isComposing \|\| e.keyCode === 229`                                   | open   | INIT     |          | Frontend-only, MessageComposer + ThreadPanel reply composer       |
| typing-stale-on-clear       | HIGH     | realtime | Typing indicator hangs up to 5s after the user deletes all text            | A types, then clears textarea → B still sees "A 입력 중…" until TTL                      | fire typing.ping+stop or explicit typing.stop signal on empty draft                                        | open   | INIT     |          | Composer.maybePing emits on each keystroke but never signals stop |
| typing-stale-on-tab-close   | HIGH     | realtime | Typing indicator lingers ~5s after tab close / network drop                | A types, force-close tab → B sees typing for ~5s                                         | backend already SREMs on disconnect (018-F); verify E2E actually hits that path; beacon fallback if needed | open   | INIT     |          | Disconnect hook exists but verify coverage                        |
| presence-lag-on-disconnect  | HIGH     | realtime | Presence offline flip is slower than expected on force-close               | A force-closes → B's member row still shows online for up to 120s (presence session TTL) | heartbeat-driven TTL is the bound; acceptable but need test + doc                                          | open   | INIT     |          | May be MED not HIGH — depends on desired SLA                      |
| unread-sidebar-lag          | HIGH     | realtime | Sidebar unread dot sometimes delays > 2s after cross-channel message       | A posts to C2; B on C1 → unread dot on C2 appears late                                   | dispatcher invalidates unread key; verify timing on hot paths                                              | open   | INIT     |          |                                                                   |
| scroll-jumps-on-new-message | HIGH     | ui       | When viewer has scrolled up, new message arrival can yank scroll to bottom | scroll up 20 msgs → A sends 3 → viewer's position changes                                | gate scrollTop write on nearBottom; add "N new" pill when not                                              | open   | INIT     |          | MessageList already has nearBottom guard — verify it holds        |
| reaction-flicker-own-toggle | MED      | ui       | Own-reaction pill briefly disappears between optimistic add and WS echo    | click 🦊 → pill shows → very briefly flickers off → reappears                            | keep byMe/optimistic flag across WS echo until count matches                                               | open   | INIT     |          | May be already fixed by upsertReactionBucket                      |

## Round summaries

See `docs/tasks/021-polish-loop.md` § Rounds for per-round detail.
