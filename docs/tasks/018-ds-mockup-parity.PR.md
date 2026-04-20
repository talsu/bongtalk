# Task 018 PR — DS Full Chat Mockup Parity + Typing Indicator + VR Guard

**Branch:** `feat/task-018-ds-mockup-parity`
**Base:** `develop` (`fc0d62f`)
**Merge style:** direct `git merge --no-ff` to develop (memory: `feedback_skip_pr_direct_merge.md`)
**Memory norms followed:** `feedback_design_system_source_of_truth.md` (raw hex/px/shadow → 0), `feedback_polite_korean.md`, `feedback_minio_naming.md` (no AWS), `feedback_retain_feature_branches.md`

## Summary

7 chunks, every one committed separately with its own `pnpm verify`:

- **A — Raw cleanup + ESLint guard** · 26 files swept for `text-[Npx]` → `text-[length:var(--fs-N)]`; `md:w-[420px]` → `md:w-thread` (new `--w-thread` token); ESLint `no-restricted-syntax` now errors on raw hex / `[Npx]` / `rgba()` / inline `box-shadow: <n>` across `apps/web/src/**`. Synthetic fixture proves the rule fires.
- **B — Topbar** · `qf-topbar__topic` reads `Channel.topic`; read-only `qf-input` search triggers `SearchOverlay`; `📌` disabled with "곧 제공 예정" tooltip; `👥` flips `useUI.memberListOpen`. New `--w-topbar-search` / `--h-topbar-search` tokens. e2e `shell/topbar-actions.e2e.ts`.
- **C — Message meta + parser** · `roleBadgeLabel` helper (OWNER → OWNER, ADMIN → MOD per mockup), zero-dep inline regex parser `renderMessageContent` for `\`inline\``, fenced blocks with optional lang pill, `@username`. `useMembers` roles feed the badge; thread panel gets it too. 7 unit tests.
- **D — Avatar status 3-state** · `features/presence/presenceStatus.ts` exports `PresenceStatus = 'online' | 'dnd' | 'offline'`. Avatar grows a `status` prop rendering `qf-avatar__status--<state>`; offline emits no dot + 0.5 opacity on the container (per mockup line 624). Backend still emits 2-state; DND renders the moment settings UI lands. 4 unit tests.
- **E — Server rail + /me/unread-totals** · `UnreadService.summarizeWorkspaceTotals(userId)` single SQL aggregate (LATERAL + GROUP BY workspace_id, reuses `(channelId, createdAt)` index from 010-B). New `MeUnreadTotalsController` + React Query hook; `WorkspaceNav` renders `qf-server-btn__unread` badges; realtime dispatcher invalidates on every channel unread bump. e2e × 2 (`server-rail-add`, `server-rail-unread`) + int test × 3 (`me-unread-totals.int.spec.ts`).
- **F — Typing indicator (pulled forward from TODO(task-029))** · `TypingService` Redis-backed: `typing:channel:<id>` SET + 5 s TTL, `typing:throttle:<uid>:<chId>` SETNX 3 s. New `SubscribeMessage('typing.ping')` + `typing.updated` broadcast + disconnect-time `SREM` fan-out. Frontend `useTypingStore` (zustand) + pure `formatTypingLabel` + `TypingIndicator` component; composer emits at 1.5 s client cadence (server floor 3 s). 7 unit + 5 int + 1 e2e.
- **G — VR parity guard** · `apps/web/e2e/ds-mockup-parity.e2e.ts`: light + dark snapshots of `/design-system/index.html#mockup` via Playwright `toHaveScreenshot`, `maxDiffPixelRatio` default 2 % env-overridable (`DS_PARITY_THRESHOLD`); structural parity test of the live shell against the same layout. Baselines seeded on first GHA run.

## Acceptance greps (all 4 return 0 outside `/design-system/` + `/brand-assets/`)

```
$ grep -rn '#[0-9a-fA-F]\{3,6\}\b' apps/web/src --include='*.tsx' --include='*.ts' --include='*.css' | wc -l
0
$ grep -rn '\[[0-9]\+px\]' apps/web/src --include='*.tsx' | wc -l
0
$ grep -rn 'rgba(\|rgb(' apps/web/src --include='*.tsx' --include='*.ts' | wc -l
0
$ grep -rn 'box-shadow:\s*[0-9]' apps/web/src | wc -l
0
```

## Verify

```
@qufox/web:typecheck ✓
@qufox/web:lint       ✓ (0 errors, 40 warnings — all pre-existing no-unused-vars)
@qufox/web:test       ✓ (35/35; +18 new since 018: 7 parseContent, 4 Avatar, 7 formatTyping)
@qufox/web:build      ✓ (Shell chunk 19.52 KB gzip; 80 KB budget headroom preserved)
@qufox/api:typecheck  ✓
```

Integration + e2e specs authored but NOT executed on the dev NAS (no live Playwright runner in this agent environment). GHA matrix will run them:

- `apps/api/test/int/channels/me-unread-totals.int.spec.ts` (3 cases)
- `apps/api/test/int/realtime/ws.typing-gateway.int.spec.ts` (5 cases)
- `apps/web/e2e/shell/topbar-actions.e2e.ts`
- `apps/web/e2e/shell/server-rail-add.e2e.ts`
- `apps/web/e2e/shell/server-rail-unread.e2e.ts`
- `apps/web/e2e/messages/typing-indicator.e2e.ts`
- `apps/web/e2e/ds-mockup-parity.e2e.ts` (dark + light)

## New artefacts

- `docs/tasks/018-ds-mockup-parity.md` — task contract
- `docs/tasks/018-ds-mockup-parity.PR.md` — this file
- `docs/tasks/018-ds-mockup-parity.review.md` — reviewer subagent verdict
- `evals/tasks/032-typing-indicator.yaml`
- `evals/tasks/033-ds-mockup-parity.yaml`

## Commits

```
b64d18d docs(task-018): DS mockup parity task contract
c1df98b feat(task-018-A): raw hex/px/shadow cleanup + ESLint guard
e0b01fc feat(task-018-B): topbar inline search + pin + member toggle
91e002f feat(task-018-C): role badge + qf-mention/code-inline/codeblock parser
6397cbc feat(task-018-D): avatar status 3-state enum (online/dnd/offline)
8fe8f60 feat(task-018-E): server rail unread badges + GET /me/unread-totals
8824fbc feat(task-018-F): typing indicator — WS gateway + Redis TTL + UI
7de34f9 feat(task-018-G): Playwright VR parity guard + evals
```

## Deferred (not in 018)

- **Pinned-messages panel** behind `📌`. Only the button exists.
- **DND settings UI** to let users flip their own status.
- **Voice channel audio / SFU** (task-028).
- **Link embed OG scraper** (not in the mockup).
- **Bold / italic / heading / list markdown** — backtick + mention only for now.
- **VR baseline fragility** — thresholds may need tuning on CI; env override exists.
