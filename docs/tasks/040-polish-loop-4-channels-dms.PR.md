# Task 040 — Polish Loop 4 (PL4) · Channels + DMs · PR

## Summary

자율 8-dimension polish loop. 새 feature 0건. 채널/DM critical path
의 시각·a11y·error·edge·mobile 측면을 round-by-round 으로 수렴.

- 8 dimensions × 8 round (cap 24, 33% used)
- 0 BLOCKER, 16 HIGH (전부 fixed), 18 MED+ (TODO 이월)
- 8 신규 회귀 spec (49 unit 통과, +11 vs 039 baseline)
- DS 4 source-of-truth 파일 git diff 0 (md5 baseline 일치)
- Reviewer subagent 1회 스폰 → H1 fix-forward 즉시 적용

## Test plan

- [x] `pnpm verify` green (lint + typecheck + 49 unit, 0 errors / 57 warn pre-existing)
- [x] `pnpm build` 성공 (6.57s)
- [x] `pnpm size` 6 budgets 모두 미달 (initial 7.80/200 KB, Shell 17.29/80 KB, vendor-react 53.36/55 KB, vendor-radix 29.69/70 KB, vendor-query 12.29/35 KB, vendor-socket 12.94/30 KB)
- [x] DS 4 파일 md5 == `.task-040-ds-baseline.txt`
- [ ] (e2e) `pnpm test:e2e` — dev/api 서버 필요, 본 PR scope 밖
- [ ] (lighthouse) prod 배포 후 측정

## Diff highlights

- `apps/web/src/App.tsx` — `AppRealtimeHost` (single useRealtimeConnection + ConnectionBanner 마운트)
- `apps/web/src/features/connection/ConnectionBanner.tsx` (신규)
- `apps/web/src/features/connection/computeConnectionBanner.ts` (신규, 6 unit tests)
- `apps/web/src/features/messages/clampAttachments.ts` (신규, 7 unit tests)
- `apps/web/src/features/messages/useMessages.ts` — onError 토스트 push
- `apps/web/src/a11y/input-label-guard.spec.ts` (신규 가드)
- `apps/web/e2e/mobile/_helpers.ts` — `MOBILE_VIEWPORT_XR (414x896)`
- `apps/web/e2e/mobile/viewport-414-shell.polish.e2e.ts` (신규 e2e)
- `apps/web/src/shell/{Shell,MobileShell,DmShell,DiscoverShell}.tsx` — banner mount 제거 + useRealtimeConnection 호출 제거 (App-level 단일 호출로 통합)
- `apps/web/src/shell/DmShell.tsx`, `MobileChannelList.tsx`, `MobileDmList.tsx`, `MobileDiscover.tsx`, `DiscoverPage.tsx`, `MessageComposer.tsx`, `MessageItem.tsx`, `MobileMessages.tsx` — input aria-label 9건
- `MessageComposer.tsx` — `clampAttachments` 통합 + warn 토스트
- `docs/tasks/040-{round-N-*,dimension-matrix}.md` — 진행 로그
- `evals/tasks/051-polish-loop-4.yaml` — eval DoD + scoring

## Deferred follow-ups (TODO)

- `task-040-follow-visual-inline-px-jsstrings`
- `task-040-follow-a11y-input-labels-out-of-scope`
- `task-040-follow-error-states-edit-delete-skeleton`
- `task-040-follow-banner-dom-render-test` (reviewer H2)
- `task-040-follow-banner-topbar-offset` (reviewer M1)
- `task-040-follow-send-fail-mutation-test` (reviewer M2)
- `task-040-follow-clamp-race` (reviewer M3)
- `task-040-follow-friends-input-label` (reviewer M4)
- `task-040-follow-dm-workspaceless-presence`
- `task-040-follow-virtualization` (R6 CM-2 / R8 P-3)
- `task-040-follow-lighthouse-ci` (R8 P-2)

## Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;
