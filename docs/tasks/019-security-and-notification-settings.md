# Task 019 — Security Hygiene (018 follow-1 ACL leak) + DnD / Notification Settings UI + main deploy

## Context

Task 018 finished DS Full Chat Mockup parity but left four follow-ups.
**follow-1 is a security leak**: `summarizeWorkspaceTotals` doesn't
join `ChannelPermissionOverride`, so a non-member sees unread counts
from private channels they can't read. This is IDOR-grade
information disclosure — "there are N unread messages in a channel
you're not in."

Separately, 018 extended `presenceStatus` to
`"online" | "dnd" | "offline"` but the user still can't set DnD
from the UI, and with mention / reply / reaction / feedback all
delivering toasts+browser notifications there's no way for a beta
user to turn the noise down. Both are user-facing settings gaps
more than engineering debt.

Task 019 closes the security hole, cleans six smaller follow-ups,
adds a DnD toggle and a notification-preferences settings page,
then **auto-promotes the merged develop to main** so the
auto-deploy pipeline takes it to prod — first application of
`feedback_auto_promote_to_main.md`.

## Scope (IN)

### A. 018-follow-1 — private channel ACL leak (security)

- `apps/api/src/channels/unread.service.ts::summarizeWorkspaceTotals`
  currently filters by `channel.workspaceId` + soft-delete only.
  Missing: filtering out channels the caller can't READ.
- Fix path: single SQL, left-join `ChannelPermissionOverride`
  (principalType=USER + caller, and principalType=ROLE +
  caller's workspace role). Exclude channels where `isPrivate = true`
  unless an override ALLOWs. Reuse the mask-composition rule
  from 012-D's `PermissionMatrix.effective` — implemented in
  SQL for performance. EXPLAIN must confirm index scan.
- Audit the sibling call sites:
  - `summarize` (channel-level, from 010)
  - `GET /workspaces/:id/unread-summary` (channel list flavour)
  - Any place `unread.service` exposes a count
  - Fix each the same way. One single-source helper if the SQL
    converges cleanly.
- Integration spec:
  `apps/api/test/int/channels/unread-private-acl.int.spec.ts`:
  - Three-user, two-channel setup (one public, one private;
    third user is not in the private).
  - `GET /me/unread-totals` returns 0 for the private channel's
    contribution when the third user calls.
  - Same for `summarize` / `unread-summary`.
- Doc nit from 018-follow-2 (`apps/api/src/channels/unread.service.ts:91`
  path comment) — fix in the same commit.

### B. Remaining 018 + 017 hygiene (5 items)

| Item                                                                                                                                                                                                                                               | Source       | Priority  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------- |
| Refresh `SocketState.channelIds` on `workspace.member.joined` + `channel.created` dispatcher events                                                                                                                                                | 018-follow-3 | LOW       |
| `ds-mockup-parity.e2e.ts` — `page.emulateMedia({ colorScheme: 'dark' })` before dark-mode capture                                                                                                                                                  | 018-follow-4 | LOW       |
| 017 task doc prose: feedback workspaceId refusal says `403 WORKSPACE_NOT_MEMBER`, actual mapping is **404**. Doc edit only, code is already consistent                                                                                             | 017-follow-1 | LOW (doc) |
| `beta-invite-required.e2e.ts` GHA matrix — `strategy.matrix.betaGate: [true, false]`                                                                                                                                                               | 017-follow-2 | NIT       |
| `migrate-webhook-worktree.sh --dry-run` — pre-check for docker container existence + base repo ownership before claiming "would run"                                                                                                               | 017-follow-4 | NIT       |
| `qufox-backup` container bind mount review — decide whether to keep `/volume2/dockers/qufox` or follow webhook into `qufox-deploy`. Backup runs no checkout today so it's lower urgency; document the decision and leave as-is if no change needed | 017-follow-5 | NIT       |

UNDERSTAND phase greps each TODO marker to confirm it's still
live; resolved ones get a review.md status update only.

### C. DnD presence toggle UI

- Prisma: `User` gains `presencePreference` column
  (`"auto" | "dnd"` enum, default `"auto"`, NOT NULL —
  Postgres metadata-only ALTER).
  - `"auto"` = 005 default behaviour (online on connect, offline
    on disconnect)
  - `"dnd"` = connect-time presence is `dnd` instead of `online`;
    disconnect still goes to `offline`
- New endpoint `PATCH /me/presence` body `{ status: "online" | "dnd" }`:
  - Writes to `User.presencePreference`.
  - Also emits an immediate `presence.updated` outbox event so
    the change propagates to other viewers without waiting for
    reconnect.
  - Rate limit: 20 req/min/user.
- WS gateway on connect reads `presencePreference` and chooses
  initial Redis SET state accordingly.
- Frontend:
  - BottomBar profile area gains a status dot
    (`qf-avatar__status--online|dnd|offline`) overlaid on the
    avatar.
  - Click → Radix dropdown menu:
    - "Online" (default)
    - "Do not disturb"
    - (disabled) "Invisible — 곧 제공 예정"
  - Select → optimistic local update + `PATCH /me/presence`
    call. Error → revert + toast.
  - Hook: `usePresenceStatus()` returns effective status + setter.
- E2E `apps/web/e2e/shell/presence-toggle.e2e.ts`:
  - Click dropdown → pick DnD → self dot becomes dnd.
  - Second context: remote user sees the dnd dot within 2 s.

### D. Notification preferences UI

- Prisma: new `UserNotificationPreference` table
  ```
  id           uuid pk
  userId       uuid fk -> User.id ON DELETE CASCADE
  workspaceId  uuid? fk -> Workspace.id ON DELETE CASCADE   -- null = global default
  eventType    enum MENTION | REPLY | REACTION | DIRECT
  channel      enum TOAST | BROWSER | BOTH | OFF
  updatedAt    timestamptz default now()
  unique (userId, workspaceId, eventType)
  ```
  - Indexes: `(userId, eventType)` (lookup), `(userId, workspaceId)`
    (settings page load)
- API:
  - `GET /me/notification-preferences` → full list (all workspaces
    the user is in + global row)
  - `PUT /me/notification-preferences` body
    `{ workspaceId?, eventType, channel }` → upsert
  - ACL: `workspaceId` must be a workspace the caller is a member
    of (else 403), or null (global)
- Resolution rule (in the dispatcher, before firing a toast or
  Notification):
  1. Look up `(userId, workspaceId, eventType)` — if found, use
     its `channel`
  2. Else look up `(userId, workspaceId=null, eventType)` — global
     default
  3. Else fall back to hardcoded default: `BOTH` for mention and
     reply, `TOAST` for reaction, `BOTH` for direct
- Dispatcher integration: `mention.received` / `message.thread.replied`
  /`message.reaction.added` / direct-message (future) each check
  the resolved `channel` before calling the toast queue /
  Notification API.
- Settings page:
  - New route `/settings/notifications` (new layout — skeletal
    settings shell, nav with "Notifications" as the single item
    for now; extensible for future `/settings/profile` etc.)
  - Tab bar at the top: "Global" + one tab per workspace
  - Each tab shows a table: 4 rows (MENTION / REPLY / REACTION /
    DIRECT) × 4 radio columns (TOAST / BROWSER / BOTH / OFF)
  - Changing a radio → immediate `PUT`, optimistic update, toast
    on failure with revert
- BottomBar profile menu grows a "Settings" link → `/settings`
- E2E `apps/web/e2e/shell/notification-settings.e2e.ts`:
  - Navigate to settings, flip MENTION to OFF on a workspace
  - Send a mention from another user in that workspace
  - Confirm the receiving user gets NO toast, but DOES see the
    unread dot + sidebar badge (those are 010, not notification)
  - Flip back to BOTH → toast fires on next mention

### E. develop → main auto-promotion + deploy verify

**First application of `feedback_auto_promote_to_main.md`.**

After reviewer approves + `git merge --no-ff feat/task-019-...`
into develop + push:

1. `git checkout main && git pull --ff-only`
2. `git merge --no-ff develop -m "Deploy task-019 to prod: security ACL fix + DnD + notification settings"`
3. `git push origin main`
4. Wait 1–3 min for the webhook pipeline
5. `tail -1 /volume2/dockers/qufox/.deploy/audit.jsonl | python3 -c 'import json,sys; r=json.loads(next(sys.stdin)); print("sha:", r.get("sha"), "exitCode:", r.get("exitCode"))'`
   — confirm `exitCode=0` and `sha` matches the main tip
6. `curl -sk -o /dev/null -w '%{http_code}\n' https://qufox.com/api/readyz`
   — expect `200`
7. If either check fails: stop the auto-promotion path, report
   to user, offer `scripts/deploy/rollback.sh api` and
   `scripts/deploy/rollback.sh web` as the next step

Because task-018 changes haven't shipped to main yet, this
promotion carries **018 + 019** to prod together.

## Scope (OUT) — future tasks

- Schedule-based DnD (weekdays/weekends, quiet hours)
- Invisible presence (user appears offline to others while still
  receiving messages)
- Email / push / SMS notification channels
- Daily digest
- Cross-device read-state sync beyond what 010 already does
- Mobile responsive shell (drawer) — next task candidate
- Loki self-hosted logs
- Korean morphological analyzer (mecab-ko)
- PITR / WAL archiving, sops / age
- 010/011/012 LOW/NIT residue — next hygiene sweep

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- `pnpm --filter @qufox/api test:int` green on GHA, new specs:
  - `unread-private-acl.int.spec.ts` (security regression guard
    — must fail without the ACL fix, pass with)
  - `notification-preferences.int.spec.ts`
  - `presence-patch.int.spec.ts`
- `pnpm --filter @qufox/web test:e2e` green on GHA, new specs:
  - `shell/presence-toggle.e2e.ts`
  - `shell/notification-settings.e2e.ts`
- Two Prisma migrations, **reversible-first**:
  - `add_user_presence_preference.sql` + down
  - `add_user_notification_preferences.sql` + down
- ACL coverage audit: every unread-aggregation site in
  `apps/api/src/channels/` joins `ChannelPermissionOverride` or
  delegates to `ChannelAccessService`. List covered in PR.md.
- TODO regression:
  - `grep -rn 'TODO(task-018-follow-1\|TODO(task-018-follow-2\|TODO(task-018-follow-3\|TODO(task-018-follow-4\|TODO(task-017-follow-1\|TODO(task-017-follow-2\|TODO(task-017-follow-4\|TODO(task-017-follow-5' --include='*.ts' --include='*.tsx' --include='*.sh' .` returns **0 lines**
- Three artefacts: `019-*.md`, `019-*.PR.md`, `019-*.review.md`
- Two evals: `evals/tasks/034-private-channel-unread-acl.yaml`,
  `035-notification-preferences.yaml`
- Reviewer subagent **actually spawned**; transcript token count
  recorded
- Direct merge to develop (PR skipped)
- **develop → main auto-promoted + pushed**
- **`audit.jsonl` last entry shows `exitCode=0` with sha matching
  `origin/main` tip**
- **`GET https://qufox.com/api/readyz` returns 200 after deploy**
- Feature branch retained
- REPORT printed automatically, includes:
  - develop merge SHA
  - **main merge SHA**
  - deploy exitCode
  - /readyz response code
  - deploy duration seconds

## Prerequisite outcomes

- 018 merged to develop (`12e5f85`); NOT yet on main
- `ChannelAccessService.resolveEffective` (012-A, 014-A) exists
- 005 presence WS gateway extensible
- 010 `unread.service` owns all the aggregate logic (single
  module)
- `DEPLOY_BRANCH_ALLOWLIST=main` in `.env.deploy` on NAS
  (017 baseline), so main push is the deploy trigger

## Design Decisions

### ACL filter is SQL-level join, not in-memory post-filter

A "fetch then filter" approach would over-fetch private-channel
unread numbers and strip them in app memory — still leaks via
logs, still costs the count query. SQL-level exclusion with
the override join is the minimum-exposure shape. The join is
always local to the aggregate query so no cross-service cost.

### DnD stored as `User.presencePreference`, not a separate row

One column, one default, Postgres metadata-only ALTER. A separate
`UserSetting` table would be over-engineered for two enum
values. If future settings grow (keyboard shortcuts, theme, etc.)
a JSON blob column or a proper table is the natural refactor —
but that's a later task.

### Notification preference lookup is 3-step fallback

`(user, workspace, eventType)` → `(user, null, eventType)` →
hardcoded. No ambiguity, no merge logic. The dispatcher does
one lookup per event, cached 5 min in-memory so a mention burst
doesn't thrash the DB.

### Settings page is its own route tree

`/settings` + nested `/settings/notifications`. 008 shell routes
are built around workspaces (`/w/:slug/...`). Settings is
user-scoped, not workspace-scoped; a separate tree avoids
forcing it into a URL shape that doesn't match.

### Main auto-promotion is non-negotiable from this task forward

`feedback_auto_promote_to_main.md` makes this automatic. Reviewer
approve + develop green + tests green → promote. No extra user
click. Safety comes from the existing pipeline gates (auto-deploy
`/readyz` + auto-rollback on failure), not from withholding the
push.

### "Invisible" status reserved, not implemented

The menu shows an "Invisible — 곧 제공 예정" disabled entry. UI
hint that the feature is known. Implementation needs extra
gateway logic (presence broadcast filtering) that isn't in
scope.

## Non-goals

- Scheduled DnD
- Actual Invisible implementation
- Email / push / digest channels
- Per-channel (not per-workspace) notification overrides
- Settings page for anything other than notifications

## Risks

- **ACL fix regresses performance** — the LEFT JOIN on
  `ChannelPermissionOverride` changes the query plan. Mitigation:
  EXPLAIN before + after; add a partial index on
  `channel_permission_override(channelId, principalType, principalId)`
  if the planner picks seq scan.
- **Preference cache staleness** — in-memory cache of
  preference lookup per-dispatcher-process means a user who
  flips MENTION=OFF sees the change after ≤5 min. Acceptable;
  document in the notification-settings E2E so the 5-min delay
  isn't mistaken for a bug.
- **Main auto-promotion carries 018 + 019 together** — bigger
  single rollout than usual. Both are verified. Rollback is
  still a single `scripts/deploy/rollback.sh api/web` since the
  `:prev` tag is from 017 (last prod-applied build). Confirm
  `:prev` still exists on the NAS before merging.
- **WS gateway connect-time read of `presencePreference`** — if
  a user is already connected when they PATCH DnD, the gateway
  must pick up the change. Solution: the PATCH handler
  additionally emits a room-scoped `presence.updated` with the
  new status; connected clients re-render immediately, no
  reconnect needed.
- **`/readyz` check timing** — auto-deploy has
  `post-deploy smoke` that already hits `/readyz`. Our explicit
  `curl` is a belt-and-braces after the fact. If the smoke
  inside auto-deploy passes but our subsequent curl fails,
  investigate nginx / TLS / cache, not app state.
- **Dispatcher integration of notification preference**
  touches four dispatcher branches — mention, reply, reaction,
  (future) direct. Consistent helper
  `shouldDeliver(event, preferences): { toast, browser }` prevents
  per-branch drift.
- **Radix dropdown accessibility** — the DnD menu must be
  keyboard operable (Enter/Space to open, arrow keys to move).
  Radix handles this by default; E2E verifies.
- **Rollback if the 019 deploy fails** — because 018 is also in
  the same rollout, `:prev` points to the 017 prod-verified
  build. Both web + api fall back together. Note in the REPORT
  so the user knows what state they land in on rollback.

## Progress Log

_Implementer fills. Order: A → B → C → D → E (merge + promote)._

- [ ] UNDERSTAND (ACL leak reproduction, 018-follow greps,
      `User` schema + presence model audit, dispatcher integration
      points)
- [ ] PLAN approved
- [ ] SCAFFOLD (ACL failing test red, migrations red, PATCH
      endpoint stubbed, settings route skeleton)
- [ ] IMPLEMENT (A → B → C → D)
- [ ] VERIFY (`pnpm verify` + GHA int + e2e green)
- [ ] OBSERVE (EXPLAIN for ACL-joined unread, DnD toggle demo
      capture, notification OFF flow screenshot)
- [ ] REFACTOR
- [ ] REPORT (direct-merge to develop → merge to main → push main
      → audit.jsonl exitCode=0 + /readyz 200 → REPORT printed
      automatically with all four SHAs + deploy result)
