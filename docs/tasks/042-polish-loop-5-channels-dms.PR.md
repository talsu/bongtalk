# Task 042 — PL5 · Channels + DMs · PR

## Summary

040 (PL4) + 041 (sweep) 직후의 두 번째 polish iteration. Round 0 으로 041
follow 7건 일괄 흡수 + 8 dim audit. 040 와 동일한 자율 반복 패턴 + 누적
fix 효과로 빠른 수렴 (총 9 round, 41 분).

- **Round 0**: 7/7 follow 처리 (jsdom-testing-env, presence-memo, composer-race-fix, mutation-unmount-cleanup, delete-success-toast, banner-multi-shell-e2e, ios-banner-screenshot)
- **R1-R8**: 1 HIGH 발견 (R5 768 viewport helper missing → fix-forward), 그 외 first-audit clean
- **040 ↔ 042**: 16 HIGH → 1 HIGH (-94%) — 040+041 누적 fix 효과
- DS 4파일 git diff 0 (md5 baseline 일치)
- 67 → 72 unit tests (+5), e2e +2

## Test plan

- [x] `pnpm verify` green (lint + typecheck + 72 unit, 0 errors / 59 warn pre-existing)
- [x] `pnpm build` 성공 + size-limit 6 budgets 모두 미달
- [x] DS 4파일 md5 == `.task-040-ds-baseline.txt`
- [x] mobile-viewport-helpers.spec.ts 3/3 (R5 + reviewer M1 보강)
- [x] useDmPresence.spec.ts 5/5 (R0 F2)
- [x] input-label-guard.spec.ts 1/1 (capital-case 확장)
- [ ] (e2e) `pnpm test:e2e` — banner-multi-shell + banner-ios-safe-area + viewport-414 모두 e2e pipeline 의존

## Diff highlights

### Round 0 — 041 follow 흡수

- `apps/web/src/a11y/input-label-guard.spec.ts` — capital-case `<Input|Textarea|Select|TextField>` regex 추가, DS primitives 제외 + `<select>`/`<textarea>` cover 유지
- `apps/web/src/features/shortcuts/CommandPalette.tsx` — `<Input>` aria-label 추가
- `apps/web/src/features/realtime/useDmPresence.ts` — signature dedup + useMemo + `added`/`updated` 둘 다 cover
- `apps/web/src/features/realtime/useDmPresence.spec.ts` (신규, 5 tests)
- `apps/web/src/features/messages/MessageComposer.tsx` — `pendingRef`/`jobsRef` mirror + 함수형 setJobs
- `apps/web/src/features/messages/MessageItem.tsx` — `isMountedRef` + `safeSet` helper, delete 성공 토스트 추가
- `apps/web/src/features/messages/MessageList.tsx` — onDelete mutateAsync (041 A-2 와 동일 패턴 유지)
- `apps/web/e2e/connection/banner-multi-shell.e2e.ts` (신규)
- `apps/web/e2e/connection/banner-ios-safe-area.e2e.ts` (신규)

### R5 + reviewer M1+M2 보강

- `apps/web/e2e/mobile/_helpers.ts` — `TABLET_VIEWPORT_PORTRAIT (768x1024)` + `MOBILE_VIEWPORTS` 4-element array
- `apps/web/src/__tests__/mobile-viewport-helpers.spec.ts` — 3 tests (XR + TABLET + 4-element 매트릭)
- `apps/web/e2e/connection/banner-ios-safe-area.e2e.ts` — inline-style 의 `safe-area-inset-top` 문자열 검증 추가

### Dimension matrix + round logs

- `docs/tasks/042-polish-loop-5-channels-dms.md` (task contract)
- `docs/tasks/042-dimension-matrix.md` (matrix 갱신)
- `docs/tasks/042-round-{0-follow-absorb,1-visual,...,8-performance}.md` (round logs 9개)
- `evals/tasks/053-polish-loop-5.yaml` (DoD)

## Reviewer 결과

- 1회 스폰 (autonomous loop 룰)
- transcript ≈ **37,300 tokens** (~28000 words / 0.75)
- 63 tool calls, 403 sec wall
- 발견: **0 BLOCKER, 0 HIGH, 7 MED, 5 LOW**
- Verdict: **approve**

리뷰어 M1 (TABLET 768 spec 누락) + M2 (iOS env() chain 미검증) 즉시 fix-forward 후 main promote. M3-M7 + L1-L5 → `task-042-follow-*` 이월.

## Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;
