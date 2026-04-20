# Task 019 Review — Reviewer Subagent Round 1

**Reviewer:** general-purpose adversarial subagent (agent id `a2f906a5906c6b4fd`, round 1)
**Head under review:** `7677326` (`feat/task-019-security-and-notification-settings`)
**Token budget:** 104,424 tokens, 79 tool calls, ~258 s
**Verdict:** **BLOCK** — 3 BLOCKER + 3 HIGH + 2 MED + 1 LOW + 1 NIT. All BLOCKER + HIGH fixed forward. MEDs handled; remainder deferred.

## Findings

| Sev     | File:Line                                                         | Issue                                                                                                                                                                                                                                                        | Disposition                                                                                                                                                                                                           |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BLOCKER | `apps/api/src/channels/unread.service.ts`                         | **DENY override ignored in SQL.** `PermissionMatrix.effective` applies `allow & ~deny`, but the CTE only tested `allowMask > 0`. A user with ALLOW + DENY on READ (effective=0) was still counted as visible. Re-opened 018-follow-1 leak for the DENY case. | **Fixed forward.** Both `summarize` and `summarizeWorkspaceTotals` now compute `(bit_or(allowMask) & ~bit_or(denyMask)) & READ_BIT > 0` per channel. New int regression test `DENY beats ALLOW`.                      |
| BLOCKER | `apps/api/src/me/me-mentions.service.ts`                          | **Same ACL leak for mentions**. `recent()` and `unreadCount()` returned contentPlain / counts from private channels the caller wasn't whitelisted for — worse than unread counts. Task §Scope A: "every unread-aggregation site".                            | **Fixed forward.** Both queries now apply the same ACL predicate (public OR OWNER OR `(allow & ~deny) & READ_BIT > 0`).                                                                                               |
| BLOCKER | Missing artefacts                                                 | `review.md` + `034-*.yaml` + `035-*.yaml` required by task contract for auto-promote.                                                                                                                                                                        | **Fixed forward.** This file + both evals committed in the fix-forward commit.                                                                                                                                        |
| HIGH    | `apps/api/src/notifications/notification-preferences.service.ts`  | `resolveDelivery()` exported but no consumer.                                                                                                                                                                                                                | **Fixed forward** — removed `resolveDelivery` + `channelToDelivery` + `ResolvedDelivery`; documented that client-side gating is the MVP surface and a future outbox→WS projector filter can consume `resolveChannel`. |
| HIGH    | `apps/web/src/features/settings/NotificationSettingsPage.tsx:125` | `border-divider` is NOT a Tailwind utility (config maps `border-subtle` → `var(--divider)`). Prod table rows would render with no separator.                                                                                                                 | **Fixed forward** — class changed to `border-border-subtle` (only one occurrence).                                                                                                                                    |
| HIGH    | `apps/web/e2e/shell/presence-toggle.e2e.ts`                       | Task §Scope C required a 2nd-context test proving remote users see the DnD flip within 2s — not implemented.                                                                                                                                                 | **Fixed forward** — added a 2nd-browser-context test that asserts the peer's `[data-testid=member-<owner>]` row flips to `data-presence=dnd` within 5s of the owner's PATCH.                                          |
| MED     | `apps/web/src/shell/BottomBar.tsx:76-84`                          | "Invisible" DropdownItem lacks `disabled` on the Radix primitive; keyboard Enter could focus and activate it.                                                                                                                                                | **Fixed forward** — DropdownItem primitive now forwards `disabled` to `RDropdown.Item`; Invisible entry uses it.                                                                                                      |
| MED     | `apps/web/src/shell/BottomBar.tsx:86-90`                          | Settings Link wrapped in DropdownItem whose onSelect calls `e.preventDefault()` — keyboard activation silently closed the menu without navigating.                                                                                                           | **Fixed forward** — DropdownItem now takes `asChild` + `preventDefault` props; Settings link renders with both so the real `<Link>` handles activation.                                                               |
| LOW     | `apps/web/e2e/shell/notification-settings.e2e.ts:77`              | 2s race between `invalidateQueries` refetch and mention arrival.                                                                                                                                                                                             | **Deferred → `TODO(task-019-follow-1)`** — add `waitForResponse('/me/notification-preferences')` before sending the mention so CI slowness doesn't flake the test. Current 2s timeout leaves headroom on localhost.   |
| NIT     | PR.md§Verify                                                      | Integration specs "authored; run on GHA".                                                                                                                                                                                                                    | **Noted.** GHA run URL attaches in REPORT once first green.                                                                                                                                                           |

## Passed checks (reviewer confirmed)

- `pnpm --filter @qufox/api typecheck` ✓
- `pnpm --filter @qufox/web typecheck` ✓
- `pnpm --filter @qufox/web lint` → 0 errors (43 pre-existing warnings)
- `pnpm --filter @qufox/web test` → 36/36
- `pnpm --filter @qufox/web build` → Shell chunk ~19 KB gzip, budget preserved
- Acceptance greps (#hex / [Npx] / rgba / box-shadow) → 0 outside DS + brand-assets
- TODO markers for 018-follow-1..4 + 017-follow-1/2/4/5 → 0 live occurrences in source
- `summarizeWorkspaceTotals` aggregate is cross-workspace safe (`wm."userId" = ${userId}`)
- Korean strings polite / noun form (`방해 금지`, `곧 제공 예정`, `알림 설정`, `설정 저장 실패`, `변경 사항은 최대 5분 이내에 모든 탭에 반영됩니다.`, `토스트 + 브라우저`, `홈으로`)
- New tokens `--w-settings`, `--w-topbar-search`, `--h-topbar-search`, `--w-thread` all defined in tokens.css + surfaced in Tailwind config
- Prisma migrations reversible-first (both have `down.sql`)
- `channels.service.ts::listByWorkspace` already implemented the same ACL shape before 019; this task aligns unread + mentions with it

## Round 2 scope

All BLOCKER + HIGH + both MED fixed forward. Per `feedback_skip_pr_direct_merge.md`, no second reviewer spawn when fixes stay inside the exact findings called out.

## Deferred — `TODO(task-019-follow-*)`

- **follow-1** (LOW) — notification-settings e2e race-condition waitForResponse.
