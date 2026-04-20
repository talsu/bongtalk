# Task 018 Review — Reviewer Subagent Round 1

**Reviewer:** general-purpose adversarial subagent (agent id `af570aacd608ea152`, round 1)
**Head under review:** `7de34f9` (`feat/task-018-ds-mockup-parity`)
**Token budget:** 118,688 tokens, 100 tool calls, ~345 s
**Verdict:** **BLOCK** — 1 BLOCKER + 1 HIGH (both fix-forward). 2 MED + 2 LOW + 1 NIT tracked.

## Findings

| Sev     | File:Line                                                                                                 | Issue                                                                                                                                                                                                                                                 | Disposition                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| BLOCKER | `docs/tasks/018-ds-mockup-parity.PR.md` (untracked), `docs/tasks/018-ds-mockup-parity.review.md` (absent) | PR.md + review.md must exist before merge per task contract.                                                                                                                                                                                          | **Fixed forward in round 1** — this file + PR.md are committed in the same chunk as the review round.                                            |
| HIGH    | `apps/web/src/features/messages/parseContent.tsx:~84`                                                     | Mention regex `@([A-Za-z0-9_]{1,32})` narrower than shared-types username rule `[a-zA-Z0-9_.-]+` → `@alice-dev` / `@user.name` split mid-token, disagrees with server-side mention-extractor.                                                         | **Fixed forward in round 1** — regex widened to `[A-Za-z0-9_.\-]{1,32}` and 2-case regression test added.                                        |
| MED     | `apps/api/src/channels/unread.service.ts:98–140`                                                          | `summarizeWorkspaceTotals` does not filter `isPrivate` / `ChannelPermissionOverride` — unread counts from private channels the caller cannot read still fold into the server-rail total (pre-existing behavior in 010-B `summarize`, broadened here). | **Deferred → `TODO(task-018-follow-1)`** — private-channel ACL filter in both `summarize` + `summarizeWorkspaceTotals`.                          |
| MED     | `apps/api/src/channels/unread.service.ts:91`                                                              | Doc comment references `apps/api/test/integration/me-unread-totals.int.spec.ts`; actual path is `apps/api/test/int/channels/…`.                                                                                                                       | **Deferred → `TODO(task-018-follow-2)`** (one-line fix).                                                                                         |
| LOW     | `apps/api/src/realtime/realtime.gateway.ts:~198` + `SocketState`                                          | `state.channelIds` captured at connect; a user who joins a new channel mid-session can't `typing.ping` it until reconnect. Mirrors existing `channel:read` behavior; acceptable.                                                                      | **Deferred → `TODO(task-018-follow-3)`** — refresh `channelIds` on `workspace.member.joined` / `channel.created` events for the viewer's socket. |
| LOW     | `apps/web/e2e/ds-mockup-parity.e2e.ts:~95`                                                                | Live-shell test does not call `page.emulateMedia`. Fine for structural asserts; flag if it grows a pixel diff.                                                                                                                                        | **Deferred → `TODO(task-018-follow-4)`** — add the call before navigation.                                                                       |
| NIT     | `apps/web/e2e/messages/typing-indicator.e2e.ts:~22`                                                       | `(await invite.json()).invite?.code ?? (await invite.json()).code` calls `.json()` twice; second call would reject (body already consumed).                                                                                                           | **Fixed forward in round 1** — cache the parsed body once.                                                                                       |

## Passed checks (reviewer confirmed)

- `pnpm --filter @qufox/web lint` — **0 errors**, 40 pre-existing warnings.
- Acceptance greps — all 4 return **0** matches outside `/design-system/` + `/brand-assets/`.
- `pnpm --filter @qufox/api typecheck` + `@qufox/web test` — **35/35**.
- Every `qf-*` class referenced in the web code exists in `components.css` (qf-typing, qf-avatar**status--{online,dnd,offline}, qf-server-btn**unread, qf-code-inline, qf-codeblock, qf-mention, qf-badge--accent, qf-topbar\_\_topic, qf-input).
- New tokens `--w-thread`, `--w-topbar-search`, `--h-topbar-search` defined in `tokens.css` AND surfaced via `tailwind.config.js`.
- `summarizeWorkspaceTotals` is **cross-workspace safe** (filters by `wm."userId" = ${userId}`; non-members can't read others' totals).
- `parseContent.tsx` uses pure React nodes — **no XSS surface** (no `dangerouslySetInnerHTML`, no `innerHTML`; fenced-block body is a text child auto-escaped by React).
- `workspace.role.changed` dispatcher branch invalidates `qk.workspaces.members` → role badge updates live.
- Korean strings are all polite / noun-form (`공지 · 일반 대화`, `곧 제공 예정`, `입력 중…`, `방해 금지`, `워크스페이스 추가`, `온라인`); no `~다`/`~해` infractions.
- VR test locks viewport + `emulateMedia({colorScheme})` + `addInitScript(data-theme)` + `document.fonts.ready` before `toHaveScreenshot` in both theme runs.

## Round 2 scope

All BLOCKER + HIGH fixed forward. Per `feedback_skip_pr_direct_merge.md`, no second reviewer spawn required when fixes are limited to the exact findings called out — round 1 verdict tracks the closure. MED + LOW deferred as `task-018-follow-*`.
