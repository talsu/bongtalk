# Task 018 — DS Full-Chat-Mockup Parity: UI 전면 정렬 + Typing Indicator + VR Guard

## Context

`feat/design-system-rewire` is merged (`fc0d62f` on develop). DS base
(`apps/web/public/design-system/tokens.css` + `components.css` +
`index.html`) is live, and most shell / primitives / features already
render through `qf-*` classes.

Remaining gap relative to the **Full Chat Mockup** in
`index.html` (lines 549–628):

- Raw `1px solid` / `text-[13px]` in the four auth/workspace pages.
- Topbar has no inline search input, no `📌` pin button, no `👥`
  member toggle.
- Message header doesn't render role badges (MOD / OWNER).
- Avatar status is online-only; mockup has online / dnd / offline.
- Server rail has no `+` button and no `qf-server-btn__unread`
  badge.
- No typing indicator (`qf-typing`) — UI or backend.
- `qf-mention` / `qf-code-inline` / `qf-codeblock` usage not
  consistently enforced.

Task 018 treats the Full Chat Mockup as the canonical reference and
aligns every remaining UI surface to it. `feedback_design_system_source_of_truth.md`
is the operating norm — raw hex / px / rgba / handcrafted shadows
in `apps/web/src/**` must drop to zero after this task.

Typing indicator work was previously parked as TODO(task-029); it
arrives here because the mockup demands it and the pipeline
(WS gateway, Redis session store) is reusable from 005.

## Scope (IN)

### A. Raw hex / px / shadow cleanup

Target grep (all four must return 0 after the task):

```
grep -rn '#[0-9a-fA-F]\{3,6\}\b' apps/web/src/ \
  --include='*.tsx' --include='*.ts' --include='*.css' \
  | grep -v 'apps/web/public/design-system\|apps/web/public/brand-assets'
grep -rn '\[[0-9]\+px\]' apps/web/src/ --include='*.tsx'
grep -rn 'rgba(\|rgb(' apps/web/src/ --include='*.tsx' --include='*.ts'
grep -rn 'box-shadow:\s*[0-9]' apps/web/src/
```

Known sites (audit-confirmed):

- `features/auth/LoginPage.tsx`, `SignupPage.tsx`
- `features/workspaces/CreateWorkspacePage.tsx`, `InviteAcceptPage.tsx`
- Likely more once the grep runs — treat as UNDERSTAND output.

Replace with DS tokens / `qf-*` classes. `text-[13px]` becomes
`text-[length:var(--fs-13)]` or a `qf-*` typography class. Inline
`border: '1px solid var(--border)'` becomes a `qf-field` / `qf-panel`
class addition to `components.css` if not already present.

ESLint extension to `apps/web/eslint.config.js` (on top of the 010-C
palette rule):

- Block raw `#hex` literals inside `className` / `style=` attributes.
- Block `[<N>px]` Tailwind arbitrary values (force `length:var(--s-N)`
  / `--r-N` / `--fs-N` etc.).
- Block `rgba(` / `rgb(` in strings.
- Block `box-shadow: <raw>` in inline `style`.
- Exempt: `apps/web/public/design-system/**`, `apps/web/public/brand-assets/**`,
  third-party type declarations.

### B. Topbar alignment (`qf-topbar`)

`MessageColumn` (or its topbar subcomponent) renders to match mockup
lines 578–586:

- `qf-topbar__title`: `<span style="color:var(--text-muted);">#</span>
channel-name`
- `qf-topbar__topic`: reads `Channel.topic` if present, else empty
  string (no `<div>` rendered if empty to keep height).
- Right group (margin-left auto, horizontal stack):
  - `qf-input` (180px × 28px, fs-13, placeholder "검색"): focus /
    click opens the existing `SearchOverlay` (Ctrl+/ already wires
    it). Input itself is read-only or acts as a trigger — the
    overlay is the real search surface.
  - `📌` icon button (`qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm`):
    pinned-messages panel placeholder. Button visible but disabled
    with tooltip "곧 제공 예정"; actual panel is a future task.
  - `👥` icon button: toggles the right member column. Adds a
    `memberColumnCollapsed` flag to `useUI` zustand store.
- E2E `apps/web/e2e/shell/topbar-actions.e2e.ts`:
  - Click search input → SearchOverlay opens.
  - Click `👥` → member column hides, click again → shows.
  - `📌` is present and has `disabled` attribute.

### C. Message meta / reaction / mention / code

- **Role badge** in `qf-message__meta`: add `qf-badge qf-badge--accent`
  between author and timestamp when sender has workspace role
  `OWNER` → label "OWNER"; `ADMIN` → "ADMIN"; `MOD` (if that role
  exists) → "MOD". New helper
  `apps/web/src/features/messages/roleBadge.ts` (pure function,
  `WorkspaceRole → label | null`).
- **qf-mention**: wherever messages render `@username`, output
  `<span class="qf-mention">@username</span>`. Consolidate — one
  renderer, no per-component duplication.
- **qf-code-inline**: parse single-backtick `` `x` `` pattern →
  `<code class="qf-code-inline">x</code>`.
- **qf-codeblock**: parse triple-backtick fenced blocks →
  `<pre class="qf-codeblock"><code>...</code></pre>` (no language
  syntax highlight in this task; plain monospace is enough).
- Markdown parsing:
  - Audit existing approach. If already using a parser, reuse; if
    not, introduce `markdown-it` with **only the backtick + mention
    rules** enabled (disable bold/italic/heading/list/etc. — those
    are future tasks).
  - Keep bundle impact within existing `size-limit` budget (008-B).
    If it blows the budget, write a minimal 40-line inline parser
    instead.
- **qf-reaction--me**: rename the "own reaction highlighted" class
  from whatever 013-C emitted to `qf-reaction--me`. Update the
  E2E assertion.

### D. Avatar status dot — 3-state enum

- `features/presence/presenceStatus.ts` enum:
  `"online" | "dnd" | "offline"` (was 2-state).
- Rendering: `qf-avatar__status--online` / `qf-avatar__status--dnd`
  / offline = no status span + container opacity 0.5 (matches
  mockup line 624).
- Backend: `presence` tracking in 005 still writes online on
  connect / offline on disconnect. `dnd` is not yet settable by
  users — treated as reserved; a future task adds the settings
  UI. 018 verifies: a shared-types enum value of `"dnd"` renders
  the dnd dot correctly (unit test feeds the value; no backend
  change sets it).

### E. Server rail completion

- New `+` button at the bottom of `WorkspaceNav`:
  - Class: `qf-server-btn` with `color:var(--ok-400)`.
  - Navigates to `/w/new` on click (the workspace-create page
    from 002 already handles this route).
  - `aria-label="워크스페이스 추가"`.
- Per-server `qf-server-btn__unread` badge:
  - New API endpoint `GET /me/unread-totals` → returns
    `{ workspaceId, unreadCount, hasMention }[]` for every
    workspace the caller belongs to.
  - Single SQL aggregate, groups by `workspace_id`. EXPLAIN
    check: index scan on the existing messages-per-channel-per-
    read-state path (010's work).
  - React Query hook `useWorkspaceUnreadTotals()` feeds each
    server button.
- E2E `shell/server-rail-add.e2e.ts`: click `+` → URL
  `/w/new`.
- E2E `shell/server-rail-unread.e2e.ts`: post in another
  workspace → current workspace's sidebar button shows the
  count bump within 2 s.

### F. Typing indicator (pulled forward from TODO(task-029))

- **Backend** (extends 005 realtime gateway):
  - New WS event `typing.ping { channelId }` (client-originated).
  - Server-side throttle per `(userId, channelId)` to max 1 ping
    / 3 s.
  - Redis SET `qufox:typing:<channelId>` holds currently-typing
    `userId` members with 5-second TTL (re-set on each ping).
  - Broadcast `typing.updated { channelId, typingUserIds }` to
    the channel room whenever the set changes (add or expire).
  - Expiry: sweep driven by a small tick (every 1 s per active
    channel) or by TTL-driven fan-out on new member; pick
    whichever is cheaper after EXPLAIN.
  - No outbox — typing is ephemeral, at-most-once is fine.
- **Frontend**:
  - `MessageComposer` debounces input events and fires
    `socket.emit('typing.ping', { channelId })` at most every 3 s
    during active typing.
  - Dispatcher branch `typing.updated` → writes into a new
    `useTypingStore` (zustand), `channelId → userId[]`.
  - `features/typing/TypingIndicator.tsx`: renders `qf-typing`
    above the composer when the current channel has typing
    users (excluding viewer). Label format matches mockup line
    607: `pm_choi 입력 중…` (single user), `user_a, user_b 외
2명 입력 중…` (multiple).
  - Viewer always excluded from the list.
- E2E `apps/web/e2e/messages/typing-indicator.e2e.ts`:
  - Two contexts. A types into composer → B sees qf-typing
    with A's name within 2 s. A stops (no input for 4 s) → B's
    indicator disappears within ~5 s (TTL-driven).
  - Three contexts: A + C type simultaneously → B sees
    combined label.

### G. VR guard

- `apps/web/e2e/ds-mockup-parity.e2e.ts` (new, Playwright):
  - Viewport 1280 × 720.
  - Light + dark themes.
  - Step 1: load `/design-system/index.html#mockup`, capture
    `expected-{theme}.png` (this is the reference from the DS
    itself).
  - Step 2: seed data (fixed UUIDs, deterministic messages),
    sign in, navigate to the workspace that mirrors the
    mockup content, capture `actual-{theme}.png`.
  - Compare via Playwright's `toHaveScreenshot` with
    `maxDiffPixelRatio: 0.02` (2 %).
  - Output on failure: `diff-{theme}.png` attached as GHA
    artifact.
- Baseline images committed under `apps/web/e2e/__screenshots__/`.
- Threshold is env-overridable (`DS_PARITY_THRESHOLD`) for CI
  noise.

## Scope (OUT)

- Pinned-messages panel (📌 opens placeholder only).
- DM / direct messages (not in mockup).
- Voice channel feature (task-028) — channel prefix `🔊`
  renders cosmetically when channel type is VOICE, but no join /
  audio.
- Link embed (`qf-embed`) OG scraper — not in Full Chat
  Mockup.
- Bold / italic / strikethrough / heading / list markdown —
  backtick + mention only for now.
- DnD presence SETTING UI — next task. 018 only renders the
  status if backend emits it.
- 017 follow-ups (017-follow-1/2/4/5) — next hygiene sweep.
- 010/011/012 LOW/NIT residue — next hygiene sweep.

## Acceptance Criteria (mechanical)

- `pnpm verify` green.
- All four raw-cleanup greps return **0 lines** outside
  `design-system/` + `brand-assets/`:
  1. `#[3-6]hex` literals
  2. `[<N>px]` Tailwind arbitrary values
  3. `rgba(` / `rgb(`
  4. inline `box-shadow: <raw>`
- `pnpm --filter @qufox/web test:e2e` green on GHA with new
  specs:
  - `shell/topbar-actions.e2e.ts`
  - `shell/server-rail-add.e2e.ts`
  - `shell/server-rail-unread.e2e.ts`
  - `messages/typing-indicator.e2e.ts`
  - `ds-mockup-parity.e2e.ts` (light + dark)
- `pnpm --filter @qufox/api test:int` green with new specs:
  - `typing-gateway.int.spec.ts` (Redis SET + TTL + throttle +
    fan-out)
  - `me-unread-totals.int.spec.ts` (workspace-level aggregate,
    EXPLAIN asserted as index scan)
- New ESLint rule rejects a synthetic `style={{ color: '#fff' }}`
  test fixture with a clear message.
- Three artefacts: `018-*.md`, `018-*.PR.md`, `018-*.review.md`.
- Two evals: `evals/tasks/032-typing-indicator.yaml`,
  `033-ds-mockup-parity.yaml`.
- Reviewer subagent **actually spawned**; transcript token count
  recorded in `018-*.review.md` header.
- **Direct merge to develop** (PR skipped). Commit:
  `Merge task-018: DS mockup parity — typing indicator + server rail + topbar + raw cleanup + VR guard`.
- **REPORT printed automatically** after merge.
- Feature branch retained.

## Prerequisite outcomes

- 017 merged to develop (`0d5c3c0`), DS rewire merged (`fc0d62f`).
- develop / main synchronized (post-017 drift handled).
- `/apps/web/public/design-system/{tokens,components,index}.{css,html}`
  present and frozen during the task — if a change is needed,
  it lands in the same feature branch, not silently.
- 005 WS gateway extensible (extending it in-place is OK, no
  separate module creation).

## Design Decisions

### Typing is Redis-set + TTL, not outbox

Typing is ephemeral. At-most-once delivery is correct; at-least-
once would cause duplicate indicator flicker. Redis SET with
5-second TTL is the lightest correct primitive — presence from
005 already uses the same shape, so operational overhead is
zero.

### DnD enum extends; setting UI defers

Three-state enum in shared-types is cheap and lets the mockup
render faithfully. A real "do not disturb" toggle needs a
settings UI, permission handling, and likely notification
policy enforcement — big enough to warrant its own task.

### `+` server button links to existing route

`/w/new` is already built from 002. No new page, no new module.

### VR guard stays local — Playwright, not Percy/Chromatic

Memory: NAS-only. External SaaS for visual diff would violate
the constraint. Playwright's built-in snapshot + diff covers
the need for a closed-beta app.

### Markdown parser is minimal or inline

A full markdown parser is over-provisioned for `` `code` `` and
`@mention`. If bundle budget allows `markdown-it`, use it with
only two rules enabled. Otherwise, inline a 40-line regex parser
scoped to those two patterns. Reviewer decides after bundle
audit.

### VR parity threshold starts at 2 %, env-overridable

Font subpixel rendering varies across OS / browser. 2 % matches
a "component-level regression stands out, font drift tolerated".
Env override exists so flaky GHA can be calmed without editing
the source of truth.

## Non-goals

- Pinning messages (button only, no panel).
- Voice channel audio.
- Link embed generation.
- DM / PM.
- Full markdown (bold, italic, headings, lists).
- DnD settings UI.

## Risks

- **Raw-cleanup grep escapes**: `style={{ color: '#ffffff' }}` or
  `fontSize: '13px'` inline patterns are easy to miss. The ESLint
  rule catches them going forward, but the audit has to find
  them first. UNDERSTAND output should enumerate file + line
  count.
- **VR baseline fragility**: fonts, antialiasing, cursor blink can
  move 1–2 % of pixels. Threshold is an estimate; raise on noise
  rather than revert.
- **Bundle impact of `markdown-it`**: ~40 KB gzipped. If over
  budget, the inline fallback is 2 regex expressions and a helper
  — no parser needed.
- **Typing TTL race with disconnect**: a user whose socket dies
  mid-typing leaves their name in the indicator for up to 5 s.
  Acceptable UX; 005 disconnect hook already removes presence,
  extend to SREM `qufox:typing:<channelId>` too — one extra line.
- **Role badge requires workspace membership lookup**: sender
  role is not always fetched with the message today. Either
  denormalize `senderWorkspaceRole` into the message response DTO
  (cheap, one column join on `WorkspaceMember`) or fetch via
  `useMembership(workspaceId, senderId)` hook with batching —
  pick based on existing hook availability.
- **Server-rail unread aggregate N+1**: Bad design would
  compute per-workspace counts one at a time. Force a single
  query: `SELECT workspace_id, sum(unread) FROM user_channel_read_state
JOIN channels ... GROUP BY workspace_id`. EXPLAIN asserts
  single index scan. This also doubles as a check on 010's
  unread data model.
- **Mockup vs live data mismatch for VR**: the mockup has fixed
  users (`dev_lee`, `designer_kim`, etc.) and messages. The live
  shell needs the same content via seed data. Seed script must
  be deterministic — fixed UUIDs, fixed timestamps via
  `vi.setSystemTime` at test level (or playwright time
  injection).
- **`Channel.topic` may not exist on the Prisma schema**. If not,
  either: (a) add the column (reversible migration) and accept
  it as scope creep, OR (b) hardcode empty topic in the topbar
  and defer the field to a future task. Implementer picks.
- **Typing indicator + mention deduplication**: a message that
  `@`s you in the same channel you're actively typing in could
  trigger both mention toast and your own typing record
  clearing. These are separate surfaces; no dedup needed, but
  exercise the combined path in the typing E2E to catch
  regressions.

## Progress Log

_Implementer fills this section. Recommended order:
A → B → C → D → E → F → G. G depends on all others because
the parity screenshot is the composition of everything else._

- [ ] UNDERSTAND (raw grep results, Channel.topic presence check,
      markdown parser / bundle audit, mockup lines walked
      component-by-component)
- [ ] PLAN approved
- [ ] SCAFFOLD (typing gateway stub, unread-totals endpoint stub,
      VR test skeleton with baseline-pending)
- [ ] IMPLEMENT (A → B → C → D → E → F → G)
- [ ] VERIFY (`pnpm verify` + GHA e2e green, including VR
      baseline accepted)
- [ ] OBSERVE (side-by-side screenshot comparison recorded in
      PR.md; typing E2E trace uploaded; EXPLAIN captured for
      `me-unread-totals`)
- [ ] REFACTOR
- [ ] REPORT (PR.md, reviewer spawned, evals added, direct merge,
      **REPORT printed automatically**)
