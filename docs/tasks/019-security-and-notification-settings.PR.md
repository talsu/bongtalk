# Task 019 PR — Security ACL fix + DnD + Notification Settings + auto-promote

**Branch:** `feat/task-019-security-and-notification-settings`
**Base:** `develop` (`12e5f85`)
**Merge style:** direct `git merge --no-ff` to develop + **develop → main auto-promotion** (first application of `feedback_auto_promote_to_main.md`)
**Memory norms:** `feedback_design_system_source_of_truth.md`, `feedback_polite_korean.md`, `feedback_minio_naming.md`, `feedback_retain_feature_branches.md`, `feedback_handoff_must_include_report.md`, `feedback_auto_promote_to_main.md`

## Summary

5 chunks, each with its own commit + `pnpm verify`:

- **A — 018-follow-1 ACL leak (security)** · `UnreadService.summarize` + `summarizeWorkspaceTotals` now filter private channels the caller can't read. WITH visible_channels CTE + inline EXISTS on ChannelPermissionOverride; public → visible, OWNER role → visible, private + (USER=me OR ROLE=my role) allow → visible, else excluded. + 018-follow-2 doc path typo fix. Regression int test `unread-private-acl.int.spec.ts` — 2 cases.
- **B — 5 hygiene follow-ups** · 018-follow-3 (gateway refreshes `SocketState.channelIds` on `channel.created` + `workspace.member.joined`) · 018-follow-4 (VR e2e live-shell locks `emulateMedia({colorScheme:'dark'})`) · 017-follow-1 (feedback refusal is 404 not 403, doc fix) · 017-follow-2 (GHA matrix `betaGate: [false, true]`) · 017-follow-4 (migrate-webhook-worktree `--dry-run` preflights docker + repo owner, exits 8 on fail) · 017-follow-5 (qufox-backup bind-mount decision documented — NO change needed).
- **C — DnD presence toggle** · Prisma migration `add_user_presence_preference` (PresencePreference enum, NOT NULL DEFAULT 'auto', metadata-only ALTER, reversible down.sql). PATCH /me/presence endpoint with 20/min rate limit; WS gateway reads preference at connect; PresenceService grows `:dnd` Redis SET + setDndForUser + dndIn; presence.updated envelope gains dndUserIds. Frontend: usePresence extended; MemberColumn resolves status via dnd → online → offline; Avatar status prop renders qf-avatar\_\_status--dnd; BottomBar Radix dropdown with Online / DnD / Invisible (disabled) / Settings.
- **D — Notification preferences** · Prisma migration `add_user_notification_preferences` (enums + table + 4 indexes, 2 partial uniques for the nullable workspaceId shape, reversible). GET + PUT /me/notification-preferences. Service with 3-step resolution + 5-min in-memory cache. Shared-types (notifications.ts) + React Query hook + dispatcher gates mention.received & message.thread.replied on resolved channel. New /settings/notifications route with tabs + 4×4 radio matrix.
- **E — merge + auto-promote + deploy verify** · this commit + the merge that carries 018 (held on develop) plus 019 to prod together.

## Acceptance greps

```
$ grep -rn 'TODO(task-018-follow-1\|TODO(task-018-follow-2\|TODO(task-018-follow-3\|TODO(task-018-follow-4\|TODO(task-017-follow-1\|TODO(task-017-follow-2\|TODO(task-017-follow-4\|TODO(task-017-follow-5' apps/ scripts/ --include='*.ts' --include='*.tsx' --include='*.sh'
0 lines
```

The task doc retains the exhaustive regex for reference; the source tree has zero live TODO markers for the covered follow-ups.

## Verify

```
@qufox/api:typecheck ✓
@qufox/web:typecheck ✓
@qufox/web:lint       ✓ (0 errors, 43 pre-existing warnings)
@qufox/web:test       ✓ 36/36
@qufox/web:build      ✓ Shell chunk 19.50 KB gzip, 80 KB budget preserved
migrate --dry-run     ✓ preflights green, existing-repo idempotent
```

Integration + e2e specs authored; run on GHA:

- `apps/api/test/int/channels/unread-private-acl.int.spec.ts` (2)
- `apps/api/test/int/channels/notification-preferences.int.spec.ts` (5)
- `apps/api/test/int/auth/presence-patch.int.spec.ts` (3)
- `apps/web/e2e/shell/presence-toggle.e2e.ts`
- `apps/web/e2e/shell/notification-settings.e2e.ts`

## New artefacts

- `docs/tasks/019-security-and-notification-settings.md`
- `docs/tasks/019-security-and-notification-settings.PR.md`
- `docs/tasks/019-security-and-notification-settings.review.md`
- `evals/tasks/034-private-channel-unread-acl.yaml`
- `evals/tasks/035-notification-preferences.yaml`

## Deferred — `TODO(task-019-follow-*)`

Populated post-reviewer if any MED/LOW findings remain.

## Rollback note

Because task-018 changes hadn't shipped to main, this promotion carries **018 + 019** to prod together. `:prev` on the NAS points to the 017 prod-verified build; `scripts/deploy/rollback.sh api` + `scripts/deploy/rollback.sh web` revert both surfaces to that baseline.
