# Task 021 — Production Polish Loop (self-repeating Rounds until quality gate)

## Context

Shipped features work end-to-end but a production-quality chat app
needs behavior that the current build doesn't reliably deliver:

- Typing indicator stays stale after a tab close / network drop
- Presence (online/offline) reflects minutes behind reality
- Unread counts on sidebar + server rail update late or not at all
- New-message scroll behavior is unpredictable (yanks position,
  or misses the bottom)
- Korean IME composition: pressing Enter mid-composition sends a
  half-formed message
- Reactions flicker when toggling own reaction (optimistic add
  then WS echo re-render)

And many more once we start looking. These aren't new features —
they're the rough edges on already-built features. Fixing them one
at a time as hand-picked tasks wouldn't scale.

Task 021 runs a **self-repeating polish loop**. pane 0 runs
discovery, picks top 6, fixes, tests, self-reviews, iterates —
all within one task. Exits automatically when quality gate is
met (no open CRITICAL/HIGH in backlog). The only human input is
the single "start" nudge at the beginning.

## Loop structure

```
INIT
  ├─ Create apps/web/e2e/polish/ harness (6 discovery scenarios)
  ├─ Create docs/polish-backlog.md with schema + initial inventory
  └─ Baseline: run full harness, record failures in backlog

Round N (repeating)
  1. DISCOVERY
       ├─ Re-run apps/web/e2e/polish/*.polish.e2e.ts
       ├─ Re-test backlog rows marked `open` (are they still live?)
       └─ Grep audit of new code paths touched in Round N-1
  2. BACKLOG UPDATE
       ├─ New findings → append as rows
       ├─ Resolved findings → `status: fixed-in-round-<N-1>`
       └─ Stale findings → `status: cannot-repro`, note why
  3. PICK TOP 6
       └─ Order: CRITICAL > HIGH > MED > LOW, then by detection date
          (older first). Cap at 6. Fewer if backlog is thinner.
  4. FIX + REGRESSION TEST
       ├─ For each picked issue: test-first (red), fix (green),
       │   regression E2E added to apps/web/e2e/polish/
       └─ One commit per fix, message format
          `fix(polish-R<N>-<slug>): <short description>`
  5. REVIEWER SUBAGENT
       ├─ Spawn against Round N's commit range
       ├─ BLOCKER/HIGH → fix forward within the Round
       └─ LOW/NIT → backlog rows (carry to future Round)
  6. pnpm verify
       └─ Red → fix within the Round; persistent red 3× → abort
          loop and report to user
  7. PROGRESS LOG
       └─ Append to docs/tasks/021-polish-loop.md § Rounds
          with Round-N summary (commits / fixes / regressions /
          reviewer verdict)
  8. EXIT CHECK
       ├─ backlog open CRITICAL = 0 AND open HIGH = 0           → EXIT normal
       ├─ two consecutive Rounds with 0 new HIGH discovered     → EXIT converged
       ├─ Round number > 10                                     → EXIT cap
       ├─ wall clock > 4 h                                      → EXIT cap
       ├─ user says "stop polish"                               → EXIT user
       └─ else                                                  → Round N+1

FINAL
  ├─ develop merge: `Merge task-021: polish loop (<N> Rounds, <M> fixes)`
  ├─ develop → main auto-promote (feedback_auto_promote_to_main)
  ├─ Deploy verify: audit.jsonl exitCode=0 + /readyz 200 + idle-window
  └─ FINAL REPORT with:
      ├─ Round count + wall clock + exit reason
      ├─ Every Round's commit table
      ├─ Backlog snapshot (resolved vs still open)
      └─ develop SHA + main SHA + deploy exitCode + /readyz
```

## Scope (IN)

### A. Polish harness (INIT)

New directory `apps/web/e2e/polish/`. Each spec is a reproducer
for a category of polish issue. Tests fail on **real current
behavior** so they act as live detectors. Each round re-runs
them.

Six initial scenarios:

- `typing-accuracy.polish.e2e.ts`

  - Two browser contexts A, B both in same channel.
  - A types "hello" into composer, then closes the tab.
  - Assert: B's `qf-typing` clears A's name within 5 s of tab close.
  - Also: A types then deletes text to empty → typing ends
    immediately (no 3 s debounce hang).

- `presence-timing.polish.e2e.ts`

  - Two contexts A, B in a workspace with A visible in B's member
    list.
  - A force-closes the browser context (not graceful disconnect).
  - Assert: B sees A flip to `offline` within 5 s.
  - Also: A reconnects → back to `online` within 2 s.

- `unread-realtime.polish.e2e.ts`

  - Two contexts, A in channel C1, B in channel C2 (same
    workspace).
  - A sends a message to C2 (via deep link or invite-post helper).
  - Assert: B's sidebar C2 unread dot appears within 2 s.
  - Server-rail badge for the workspace ticks up within 2 s.
  - No double-count when switching channels.

- `scroll-autobottom.polish.e2e.ts`

  - Seed 100 messages in a channel. B opens it, scrolled to
    bottom.
  - A sends 3 messages.
  - Assert: B's view stays at bottom (new messages visible).
  - B scrolls up 20 messages. A sends more.
  - Assert: B's scroll position does NOT jump; a "N new messages"
    pill appears at the bottom (or any equivalent UI).

- `ime-composition.polish.e2e.ts`

  - Driver types Korean using `keyboard.insertText()` or
    IME-simulating sequence.
  - Press Enter mid-composition (before `compositionend`).
  - Assert: no message sent, composer still has the in-progress
    text.
  - After `compositionend`, press Enter → one clean message sent.

- `reaction-no-flicker.polish.e2e.ts`
  - User A clicks 🦊 on a message.
  - Assert: the `qf-reaction--me` pill is visible continuously
    from click until 2 s after WS echo arrives (no disappear /
    reappear within 200 ms).

These are the _detectors_. Fixes live in the main src tree; the
polish specs assert the fix holds.

### B. Backlog schema

`docs/polish-backlog.md`:

```markdown
# Polish Backlog

Managed by Task 021+. Source of truth for polish Round selection.

## Columns

- `id` — stable identifier, kebab-case, e.g. `typing-stale-on-tab-close`
- `severity` — CRITICAL | HIGH | MED | LOW | NIT
- `area` — realtime | ui | data | perf | a11y | backend
- `title` — one-line summary
- `repro` — shortest path to reproduce (test name or manual steps)
- `candidate-fix` — one-line guess at the fix
- `status` — open | in-progress-R<N> | fixed-R<N> | cannot-repro | deferred
- `detected` — Round number first seen (`INIT` for harness seed)
- `resolved` — Round number closed (empty if still open)
- `notes` — optional, for context / reviewer quotes / references

## Rows

| id                        | severity | area     | title | repro | candidate-fix | status | detected | resolved | notes |
| ------------------------- | -------- | -------- | ----- | ----- | ------------- | ------ | -------- | -------- | ----- |
| typing-stale-on-tab-close | HIGH     | realtime | ...   | ...   | ...           | open   | INIT     |          |       |

| ...
```

One row per issue. Row is mutated in place as status changes.

### C. Initial inventory (INIT commit group)

Seed with these, then run harness to see what else surfaces:

1. `typing-stale-on-tab-close` — HIGH realtime
2. `presence-lag-on-disconnect` — HIGH realtime
3. `unread-sidebar-lag` — HIGH realtime
4. `scroll-jumps-on-new-message` — HIGH ui
5. `ime-enter-half-sends` — HIGH ui (backend-safe, frontend only)
6. `reaction-flicker-own-toggle` — MED ui

Fixes reside wherever they belong (backend gateway, client
store, React component, etc.). The backlog doesn't prescribe
the file — only the failing scenario.

### D. Round execution (repeating)

Pseudocode lives in § Loop structure above. Per-Round contract:

- **Round commit prefix**: `fix(polish-R<N>-<slug>): ...`
- **Round reviewer**: subagent spawn scoped to `git log main..HEAD`
  for Round N's range only. Record token count + verdict in
  a single line in Round summary table.
- **Round regression E2E**: each fix adds or modifies a polish
  spec. If the fix is structural (no specific scenario), add a
  unit/integration test instead. Every Round must leave `polish/`
  suite more comprehensive.
- **Round pnpm verify**: must be green before Round exits. If
  verify fails, fix within the Round. Three consecutive failed
  verify passes abort the loop.

### E. Final promotion (EXIT)

After loop exits (any reason except user interrupt):

1. `git push origin feat/task-021-polish-loop` (final state)
2. `git checkout develop && git pull --ff-only`
3. `git merge --no-ff feat/task-021-polish-loop -m "Merge task-021: polish loop — <N> Rounds, <M> fixes, exit=<reason>"`
4. `git push origin develop`
5. `git checkout main && git pull --ff-only`
6. `git merge --no-ff develop -m "Deploy task-021 to prod: polish loop"`
7. `git push origin main`
8. Wait 1–3 min, verify:
   - `audit.jsonl` last entry: `sha` matches main tip, `exitCode=0`
   - `curl -sk https://qufox.com/api/readyz` → 200
   - Idle window check (no traffic for 30 s after deploy →
     still 200)
9. Print **FINAL REPORT** (auto).

If user interrupts mid-loop, merge whatever Rounds completed
(in-progress Round is rolled back or finished depending on
state), then promote normally. Report exit-reason=user.

If loop aborts on `pnpm verify` red × 3, do NOT merge. Report
full state to user and await instructions.

## Exit criteria (priority order)

1. **Normal convergence**: backlog open CRITICAL=0 AND open HIGH=0
2. **Signal convergence**: two consecutive Rounds with 0 new HIGH
   discovered in Discovery step
3. **Hard cap — Round count**: current Round > 10
4. **Hard cap — Wall clock**: total task time > 4 h
5. **User interrupt**: "stop polish" | ESC
6. **Safety abort**: `pnpm verify` red three times in a row
   within one Round — abort, do NOT merge, report to user

## Non-negotiables

- **Feature branch retention**: `feat/task-021-polish-loop` NOT
  deleted.
- **Main promote only once** at EXIT, carrying the full loop's
  worth of fixes.
- **Reviewer subagent per Round**, not just at end.
- **Each fix has a regression E2E or unit test**. Polish with no
  test is polish that will regress.
- **Backlog file is the source of truth**. No "I'll remember
  this one" parking lots.
- **Polite Korean** in conversational text per memory.
- **DS tokens / qf-_ / qf-m-_** per memory — fixes must respect
  tokens.css / components.css / mobile.css.

## Acceptance Criteria (mechanical)

- `pnpm verify` green at FINAL.
- `docs/polish-backlog.md` exists, non-empty, schema matches § B.
- `apps/web/e2e/polish/` contains at least 6 harness specs.
- Each Round's summary table present in this doc's § Rounds
  (below Progress Log).
- Exit reason recorded in § Final REPORT.
- `git log feat/task-021-polish-loop --oneline | grep '^.* fix(polish-R[0-9]\+-'` has ≥ 1 commit per Round × Round count.
- Reviewer transcript token count recorded per Round.
- Three artefacts: `021-*.md` (this file), `021-*.PR.md`,
  `021-*.review.md` (aggregate across Rounds).
- **develop → main auto-promoted** at EXIT.
- `audit.jsonl` last entry `exitCode=0` + sha matches main tip.
- `GET https://qufox.com/api/readyz` = 200 (idle window verified).
- FINAL REPORT printed with:
  - Round count / wall clock / exit reason
  - Per-Round commit + reviewer table
  - Backlog snapshot: resolved vs still open (severity-grouped)
  - develop SHA + main SHA + deploy exitCode + /readyz
- Feature branch retained.

## Prerequisite outcomes

- 020 merged to develop + main (deploy stability baseline).
- `OutboxHealthIndicator` idle/stalled distinction landed (so
  loop's rapid deploy verification doesn't false-fail).
- `feedback_auto_promote_to_main.md` memory still in effect.
- Playwright harness + GHA E2E workflow from 011-D operational.
- `docs/tasks/` conventions in place.

## Design Decisions

### Single task, multiple Rounds — not N separate tasks

User asked for self-repeating loop. Separate tasks would need
user "go" for each Round. Single task runs N Rounds under the
same contract, same feature branch, same final deploy.

### Main promote once at EXIT, not per Round

Per-Round prod deploy would mean 5–10 auto-deploys in one task.
Noisy, risks rollback churn, dilutes observability. Carrying
the full loop to main in one merge is a single verifiable
event.

### Reviewer per Round, not once

Each Round introduces ~6 small changes across the codebase.
Reviewing all Rounds at the end would produce a huge diff and
miss cross-Round regressions. Per-Round review catches issues
locally.

### Backlog file in repo, not in memory

Polish backlog is _code-adjacent_ — each row references repro
paths, commits, scenarios. Memory is for cross-session facts,
not per-task state. Repo file is versioned + reviewable.

### Exit on HIGH/CRITICAL=0, not MED/LOW=0

MED and LOW are genuinely in-the-weeds polish. Keeping them as
forever backlog is fine; they get picked off in future polish
tasks. Holding the loop hostage for LOW would balloon the task.

### Hard caps prevent runaway

10 Rounds / 4 h are safety bounds — the loop should converge
far earlier (expected 4–6 Rounds, 2–3 h). Caps are the "stop
the bleeding" lever if the fix-verify ratio is off.

### Per-Round commit prefix `fix(polish-R<N>-<slug>)`

Uniform prefix makes Round boundaries scannable in git log.
`--grep 'polish-R3'` returns exactly Round 3.

## Non-goals

- New features (attachments thumbnail server, voice, DMs, etc.)
- Redesigning DS tokens or qf-\* classes (DS-source-of-truth
  memory applies)
- Infrastructure work (Loki, PITR, sops) — separate tasks
- Perf benchmarking / load testing beyond what the polish
  scenarios exercise
- Translating error messages (i18n out of scope)

## Risks

- **Discovery harness is biased toward what we already noticed.**
  Playwright can't find problems we didn't think to assert.
  Mitigation: Round-N Discovery also runs a grep audit of new
  code paths touched in Round N-1 (dispatcher branches, useEffect
  cleanup, lifecycle hooks) and adds specs for any gap.

- **Round fix introduces regression across Rounds.** Fix in
  Round 2 could break a Round 1 assertion. Mitigation: Round
  Discovery re-runs ALL polish specs (not just new ones) first.
  Full regression catch.

- **Infinite loop on tricky issue.** The same HIGH keeps getting
  picked but never fully fixed (fix causes adjacent HIGH).
  Mitigation: convergence signal (2 Rounds with 0 new HIGH)
  triggers exit even if backlog technically has open rows;
  unresolved HIGH is carried to the final REPORT for user
  decision.

- **Reviewer subagent cost across 10 Rounds.** 10 spawns × 50–
  120k tokens each. Bounded; acceptable one-time cost for polish.

- **Main promote at EXIT carries 30+ commits.** Rollback unit is
  coarse — rolling back returns to pre-021 main. Mitigation:
  each fix commit is atomic so a bad fix can be reverted
  individually on the feature branch before FINAL promote if
  Discovery flags it.

- **polish-backlog.md merge conflicts** with future parallel
  tasks. Mitigation: this task owns the file. If a future task
  needs to add an issue, it goes through a Polish Round, not
  direct edit.

- **Korean IME test is tricky in Playwright.** Real IME input is
  not straightforward to simulate. Mitigation: use
  `keyboard.insertText()` combined with `compositionStart/End`
  dispatch, or fall back to a programmatic composition event if
  the fake doesn't trigger the real code path. Document
  limitation in the spec.

- **polish harness itself takes time to run each Round.** 6
  scenarios × ~20 s each = 2 min per Round. Acceptable.

- **Wall clock cap is generous**: 4 h allows 10 Rounds at ~25
  min each. If a Round consistently takes 45 min, the cap
  kicks in at Round 5 and the loop exits early.

## Progress Log

_Implementer fills this section. Append one bullet per Round in §
Rounds (below) as the loop runs._

- [ ] UNDERSTAND (harness file layout, backlog schema, 020
      baseline state, deployment path confirmation)
- [ ] INIT (harness specs committed red, backlog seeded, baseline
      polish-spec run recorded)
- [ ] Round loop begins - See § Rounds below for per-Round entries
- [ ] EXIT condition met, reason recorded
- [ ] FINAL merge + promote + deploy verify
- [ ] FINAL REPORT printed automatically

## Rounds

_One subsection per Round. Implementer appends._

### Round 1

_(not yet run)_

- Commits:
- Fixes (backlog rows closed):
- New discoveries (backlog rows opened):
- Reviewer verdict:
- pnpm verify:
- Wall clock:

### Round 2

_(not yet run)_

### Round 3

_(not yet run)_

_... up to Round 10 if needed._

## Final REPORT

_(filled at EXIT)_

- Total Rounds run:
- Wall clock:
- Exit reason:
- Backlog snapshot:
  - Resolved CRITICAL/HIGH/MED/LOW/NIT counts
  - Still-open CRITICAL/HIGH/MED/LOW/NIT counts
- develop merge SHA:
- main merge SHA:
- deploy exitCode:
- /readyz response:
- idle-window /readyz verified:
- Deploy duration (s):
