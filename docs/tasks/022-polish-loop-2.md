# Task 022 — Production Polish Loop #2 (Round 4+, new surfaces after 021)

## Context

Task 021 converged in 3 Rounds (5 HIGH fixed, 1 cannot-repro, 3
deferred as harness-guarded backend SLAs). Since 021 merged,
30+ commits landed on develop → main covering:

- **DS v3 upgrade** — 102-icon pack + `Icon` primitive + emoji-
  glyph swap, rewritten `/design-system/index.html`
- **Composer v2** — DS-parity rewrite with auto-grow, upward
  menu, emoji picker, real file upload slice
- **Thread v2** — new primitives (chip / panel / message /
  reply composer)
- **Channel settings** — new screen with gear entry,
  `SettingsOverlay` reusable primitive
- **Members modal** — membership management moved from inline
  sidebar list to a dedicated modal
- **Channel DnD** — permission-gated drag + row-wide target +
  insertion line
- **Topbar inline search** — replaces the old Ctrl+/ modal overlay
- **UX finish** — toast/alert stacking, channel row full click,
  tight icon hit-areas, BottomBar width pin, etc.

The 021 polish harness (6 scenarios) was scoped to the
surfaces as they existed on 2026-04-21. None of it covers the
new composer, thread v2, settings overlay, members modal, DnD,
or inline search. A polish regression net written for yesterday
can't catch the bugs shipped today.

Task 022 is Polish Loop #2: reuse 021's loop machinery, extend
the harness with 8 new scenarios for the new surfaces, and run
Rounds 4+ until the quality gate is met.

## Loop structure

Identical to Task 021. Summary (reference § Loop structure in
`docs/tasks/021-polish-loop.md` for the full pseudo-code):

- `INIT` — extend `apps/web/e2e/polish/` with 8 new scenarios,
  append new rows to `docs/polish-backlog.md`
- `Round N` (N starts at 4) — Discovery → backlog update →
  pick top 6 → fix + regression test → reviewer subagent →
  `pnpm verify` → progress log → exit check
- `FINAL` — develop merge → main auto-promote → deploy verify
  → FINAL REPORT

All round commits prefixed `fix(polish-R<N>-<slug>): ...` so
`git log --grep 'polish-R4'` scans cleanly.

## Scope (IN)

### A. Harness extension (INIT commit group)

Eight new polish specs under `apps/web/e2e/polish/`. Each is a
detector — it asserts production-grade behavior and fails on
current live behavior (if broken) so Round 4 picks it up.

**A-1. `composer-upload.polish.e2e.ts`** — Composer v2 (`fa3cd97`)

- Drag-drop a 1 MB PNG → card shows upload progress
- Upload failure injection → user-visible error toast + retry
  button, card does NOT silently disappear
- Cancel during upload → card removed, no orphan S3 row
- Message submit while upload in flight → wait for completion
  (or explicit warning)
- optimistic echo: self-send shows at most once (no double-
  render on WS echo)

**A-2. `composer-autogrow.polish.e2e.ts`** — Composer v2

- Paste 10-line text → composer grows to fit (up to cap)
- Continue typing past cap → composer stops growing, inner
  scrolls
- Clear → composer shrinks back to single-line default
- Shift+Enter inserts newline cleanly (no IME regression)

**A-3. `thread-panel-state.polish.e2e.ts`** — Thread v2 (`c1f613d`)

- Open thread → type 5-char draft → close panel → reopen →
  draft preserved (or explicitly documented as intentional loss)
- Scroll up in thread → close → reopen → scroll position
  restored (or explicitly top)
- `?thread=<id>` URL reload → panel opens with correct root
- Switching channel while thread open → panel closes
  (matches 014's design decision)

**A-4. `settings-overlay-stacking.polish.e2e.ts`** — SettingsOverlay
(`a5d20b7` + `0546d7b` + `f37fa9f`)

- Open channel settings overlay → toast fires → toast above
  overlay (z-index)
- Open settings → open confirm alert dialog → dialog above
  settings (per `f37fa9f`)
- ESC closes topmost overlay first, not both
- Outside click on settings → closes settings (not propagate)
- Ctrl+K while settings open: either commands palette opens
  above settings, or Ctrl+K is suppressed; assert one
  deterministic behavior

**A-5. `channel-settings-screen.polish.e2e.ts`** — Channel settings
screen (`f811687`)

- Gear icon entry → settings screen opens
- Edit description → save → list view shows new description
  within 2 s (optimistic + WS echo)
- Edit description → cancel → no mutation
- Concurrent edit from another user → latest-writer-wins
  pattern with clear UI (or document conflict behavior)

**A-6. `members-modal.polish.e2e.ts`** — Members modal (`c5add25`)

- Open from topbar/sidebar → modal appears
- ESC closes modal
- Click outside modal → closes
- Tab order: focusable elements reachable in logical order
- Search input filters list live
- Role badge shown for OWNER / ADMIN / MOD

**A-7. `channel-dnd-permission.polish.e2e.ts`** — Channel DnD
(`9d949e8`)

- OWNER / ADMIN: drag row → insertion line appears → drop →
  order persists on refresh
- MEMBER (no reorder permission): drag attempt → insertion
  line does NOT appear OR shows blocked cursor; no mutation
- Cross-category drop lands in target category
- Concurrent reorder from another admin → final order
  deterministic (WS echo reconciles)

**A-8. `topbar-inline-search.polish.e2e.ts`** — Inline search
(`4e0caf8`)

- Focus inline search input → dropdown renders on first
  keystroke
- Arrow down / up navigates results
- Enter jumps to selected message (`?msg=<id>`)
- ESC closes dropdown
- Old `SearchOverlay` modal route removed — `/search` route
  either redirects inline or 404 (assert it's gone)

### B. Backlog seed (INIT append)

Append new rows to existing `docs/polish-backlog.md`. Rows from
021 remain untouched (status stays `fixed-R1` / `fixed-R2` /
`cannot-repro` / `deferred`). New rows carry `detected: R4`
once Round 4 Discovery confirms them.

Seed candidates (harness run confirms or drops):

1. `composer-upload-error-state-missing` — HIGH, ui
2. `composer-autogrow-cap-missing` — MED, ui
3. `thread-panel-draft-loss` — HIGH, ui
4. `settings-overlay-esc-palette-conflict` — MED, a11y
5. `settings-overlay-backdrop-click` — MED, ui
6. `channel-settings-save-echo-lag` — MED, realtime
7. `members-modal-keyboard-nav` — MED, a11y
8. `channel-dnd-permission-feedback` — HIGH, a11y
9. `channel-dnd-cross-category-drop` — MED, ui
10. `inline-search-keyboard-nav` — HIGH, a11y
11. `inline-search-old-route-leak` — MED, cleanup

Exact severity assigned after Discovery. Some may come in as
`cannot-repro` if the harness finds the behavior already
correct.

### C. Round 4+ execution

Identical to 021 Round mechanics:

- Round cap: **6 fixes per Round**
- Max Round in this task: **6** (Round 4 through Round 9 max)
- Wall clock cap: **4 h**
- Reviewer subagent per Round
- `pnpm verify` green at Round close
- Abort if verify red 3× consecutively

### D. Final develop → main auto-promotion

Standard flow per `feedback_auto_promote_to_main.md`:

1. `git push origin feat/task-022-polish-loop-2` (final)
2. `git checkout develop && git pull --ff-only`
3. `git merge --no-ff feat/task-022-polish-loop-2 -m "Merge task-022: polish loop #2 — <N> Rounds, <M> fixes, exit=<reason>"`
4. `git push origin develop`
5. `git checkout main && git pull --ff-only`
6. `git merge --no-ff develop -m "Deploy task-022 to prod: polish loop #2"`
7. `git push origin main`
8. Wait 1–3 min
9. Verify audit.jsonl `exitCode=0` + sha matches main tip +
   `/readyz` 200 + idle-window 30 s
10. Print FINAL REPORT

## Exit criteria (priority)

1. Backlog open CRITICAL = 0 AND open HIGH = 0 (normal)
2. Two consecutive Rounds with 0 new HIGH discovered (converged)
3. Round number > Round 9 (Max Round cap: 6 rounds in this task)
4. Wall clock > 4 h (hard cap)
5. User "stop polish" / ESC (interrupt)
6. `pnpm verify` red 3× in one Round (abort, no merge, report)

## Scope (OUT)

- New features (custom emoji, mecab-ko FTS, mobile responsive,
  Loki, PITR, sops) — future tasks
- DS token / component redesigns (DS is source of truth)
- Infrastructure work

## Non-negotiables

- Feature branch `feat/task-022-polish-loop-2` retained
- Main promote ONLY at EXIT (single rollout for the whole loop)
- Reviewer subagent per Round
- Each fix adds a regression spec (polish E2E or unit)
- `polish-backlog.md` is the source of truth — no "I'll
  remember" parking lots
- Polite Korean in conversational text
- DS tokens / `qf-*` / `qf-m-*` respected — no raw hex/px/shadow

## Acceptance Criteria (mechanical)

- `pnpm verify` green at FINAL.
- 8 new polish specs exist under `apps/web/e2e/polish/`:
  composer-upload, composer-autogrow, thread-panel-state,
  settings-overlay-stacking, channel-settings-screen,
  members-modal, channel-dnd-permission, topbar-inline-search.
- `docs/polish-backlog.md` extended — 021 rows intact, new
  rows present with proper status.
- Every Round has at least one `fix(polish-R<N>-...)` commit
  (if Round completed any fixes).
- Reviewer transcript token count recorded per Round in this
  doc's § Rounds section.
- Three artefacts: `022-*.md`, `022-*.PR.md`, `022-*.review.md`
  (aggregate reviewer output across Rounds).
- develop → main auto-promoted at EXIT.
- `audit.jsonl` last entry shows `exitCode=0` + sha matching
  `origin/main` tip.
- `GET https://qufox.com/api/readyz` returns 200 (idle-window
  verified for 30 s after deploy).
- FINAL REPORT printed automatically, includes:
  - Round count (4 through N), wall clock, exit reason
  - Per-Round commit + reviewer table
  - Backlog snapshot (resolved vs still open, severity-grouped,
    separating 021 rows from 022 rows)
  - develop SHA + main SHA + deploy exitCode + /readyz + idle
    window confirmation + deploy duration
- Feature branch retained.

## Prerequisite outcomes

- 021 merged to develop + main (`2f9c0fa` deploy).
- `docs/polish-backlog.md` exists with Round 2 close snapshot.
- `apps/web/e2e/polish/` directory exists with 6 existing
  specs.
- `OutboxHealthIndicator` idle/stalled fix from 020 live (so
  rapid deploy verify doesn't false-fail).
- DS v3 + Composer v2 + Thread v2 + SettingsOverlay + Members
  modal + Channel DnD + inline search all live on main.

## Design Decisions

### Round numbering continues from 021

The loop is semantically the same machine. 021 used R1–R3.
Task 022 starts at R4 so `git log --grep 'polish-R'` stays
a single ascending series. Progress log in this doc uses R4,
R5, R6 ... up to R9 cap.

### Same backlog file, appended

Splitting into `polish-backlog-022.md` loses cross-task
traceability. 021's `cannot-repro` / `deferred` rows may
reopen based on new harness runs — keeping them in the same
table means reopening is a status mutation, not a row copy.

### Harness extension, not rewrite

021's 6 harness specs stay as-is. They act as regression
guard against the new changes (did the DS v3 refactor break
typing or scroll?). Discovery in R4 runs all 14 specs.

### Max Round 6 in this task

Adds up to 9 total polish rounds across the two tasks.
Convergence expected in 4 rounds (R4–R7). Cap is the safety
brake.

### Reviewer subagent per Round remains

Per-Round review catches cross-Round regressions while the
context is fresh. End-of-task review alone would miss most.

### HIGH + CRITICAL = 0 exit threshold unchanged

MED is legitimately polish that can live as backlog for the
next polish sprint. Holding the loop for MED resolution
balloons scope.

## Non-goals

- Redesigning DS components (DS is frozen per memory)
- Adding new product features
- Migrating database / infra
- Touching 021 rows that are `fixed` / `deferred` / `cannot-repro`
  unless harness reopens them

## Risks

- **New Composer v2 / Thread v2 surface is code-new; backlog
  candidates may lean heavier than predicted.** Round cap of 6
  keeps each Round bounded; Max Round 6 keeps the task
  bounded. If quality gate isn't met by R9, FINAL REPORT
  documents what's left and a future task picks up.
- **Harness scenarios rely on deterministic seed data.** Same
  caveat as 021. Reuse the `beforeAll` seed helpers already
  used by the 6 existing specs.
- **DnD permission test needs multi-role fixtures.** OWNER +
  MEMBER sessions in one test. Use existing Playwright
  fixture patterns from 012-D (`private-channel-attachment.e2e.ts`
  uses two contexts with different roles).
- **IME / clipboard tests in Playwright are OS-dependent.** GHA
  runner differences may surface; follow the 021 IME pattern
  (dispatch composition events programmatically if the real
  IME doesn't trigger).
- **Reviewer subagent cost for up to 6 Rounds.** Bounded;
  acceptable polish overhead.
- **Main promote at EXIT carries all Round fixes as one rollout.**
  Rollback unit is coarse per Task 021 precedent; each commit
  is atomic so individual reverts on the feature branch are
  possible before FINAL.
- **Merge conflict with `polish-backlog.md` from ongoing manual
  edits.** Task 022 owns the file. If any Round bumps into
  unexpected edits, surface to user.

## Progress Log

_Implementer fills this section. Append one bullet per Round
in § Rounds below as the loop runs._

- [ ] UNDERSTAND (8 harness stubs written, 021 polish file
      layout audited, backlog columns reconfirmed, 020
      baseline verified green)
- [ ] INIT (8 harness specs committed + seeded backlog rows)
- [ ] Round loop begins at R4 - See § Rounds below
- [ ] EXIT condition met, reason recorded
- [ ] FINAL merge + promote + deploy verify
- [ ] FINAL REPORT printed automatically

## Rounds

_Implementer appends one subsection per Round._

### Round 4

- Commits:
  - `7e009b7` chore(polish-INIT-022): 8 new harness specs + backlog rows seeded
  - `b4c614a` fix(polish-R4-composer-upload-error-state): retryable failure chip
  - `233572e` fix(polish-R4-thread-panel-draft-loss): persist thread reply drafts
- Fixes closed (2 HIGH):
  - `composer-upload-error-state-missing` → fixed-R4 (failed upload chips persist with retry)
  - `thread-panel-draft-loss` → fixed-R4 (compose-store keyed by `thread:<rootId>`)
- Reclassified cannot-repro after Discovery audit (9 rows): composer-autogrow-cap-missing, settings-overlay-esc-palette-conflict, settings-overlay-backdrop-click, channel-settings-save-echo-lag, members-modal-keyboard-nav, channel-dnd-permission-feedback, channel-dnd-cross-category-drop, inline-search-keyboard-nav, inline-search-old-route-leak.
- Reviewer verdict: PASS (agent `af27f7b787cffeaf6`, 62,532 tokens, 23 tools, 106s) — 0 BLOCKER / 0 HIGH / 4 MED (job-clear-on-submit, retry UUID regen, setDraft closure, stacking test walk-up). All MED judged acceptable; no fix-forward.
- pnpm verify: 19/19 green, 0 errors.
- Exit check: open CRITICAL=0, open HIGH=0 → criterion (a) MET. R5 will run a confirm-pass (discovery-only) to satisfy criterion (b) 2-consecutive-Rounds convergence before FINAL.

### Round 5

_(not yet run)_

### Round 6

_(not yet run)_

### Round 7

_(not yet run)_

### Round 8

_(not yet run)_

### Round 9

_(not yet run)_

## Final REPORT

_(filled at EXIT)_

- Total Rounds run (from R4 to R?):
- Wall clock:
- Exit reason:
- Backlog snapshot (021 rows preserved):
  - Resolved (this task): CRITICAL / HIGH / MED / LOW / NIT counts
  - Still-open: CRITICAL / HIGH / MED / LOW / NIT counts
  - Deferred / cannot-repro across both tasks
- develop merge SHA:
- main merge SHA:
- Deploy exitCode:
- `/readyz` response:
- Idle-window `/readyz` verified:
- Deploy duration (s):
