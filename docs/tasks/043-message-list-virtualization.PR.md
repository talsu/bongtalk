# Task 043 — Message List Virtualization · PR

## Summary

040 R6/R8 deferred (`task-040-follow-virtualization`) 회수. 데스크톱
`MessageList.tsx` 에 `@tanstack/react-virtual` 도입으로 1000+ 메시지에서
DOM node O(N) → O(visible window + overscan).

- A: react-virtual 적용 (이미 설치된 ^3.13.24 사용, dep 추가 없음)
- B: Anchor scroll 4 시나리오 — pure helper `messageAnchor.ts` + layout effect
- C: 12 anchor unit + 2 anchor/virtualization e2e 추가
- 모바일 (`MobileMessages.tsx`) 은 별도 컴포넌트 + 다른 gesture/keyboard-dodge 동작 → 본 task 의 risk-balance scope 밖, follow-up 이월
- DS 4파일 git diff 0 (md5 baseline 일치)
- unit tests: 72 → 86 (+14)

## Test plan

- [x] `pnpm verify` green (lint + typecheck + 86 unit, 0 errors / 60 warn pre-existing)
- [x] `pnpm build` 성공 + size-limit 6 budgets 모두 미달
- [x] DS 4파일 md5 == `.task-040-ds-baseline.txt`
- [x] messageAnchor.spec.ts 12/12
- [ ] (e2e) `pnpm test:e2e` — virtualization.e2e.ts (1000 fixture seed) + messagelist-anchor.e2e.ts dev/api pipeline 의존

## Diff highlights

### A — react-virtual + MessageList 변환

- `apps/web/src/features/messages/MessageList.tsx` — `useVirtualizer({ count, getScrollElement, estimateSize: () => 64, overscan: 8 })`, row container 에 `ref={virtualizer.measureElement}` + `data-testid="message-row"`, absolute-positioned with `transform: translateY(start)`.
- inner wrapper `data-testid="virtual-list-inner"` 가 `height: virtualizer.getTotalSize()` 로 scrollbar 정확
- 가변 높이 (텍스트 / 첨부 / 리액션 / 코드블록) 자동 측정

### B — Anchor scroll 4 시나리오

- `apps/web/src/features/messages/messageAnchor.ts` (신규) — `takeAnchorSnapshot` / `restoreAnchorScrollTop` / `isNearBottom` 순수 함수
- B-1 history prepend: scroll listener 안 `el.scrollTop < 100 && hasNextPage` 조건 만족 시 snapshot 캡처 → `fetchNextPage()` → useLayoutEffect 가 prepend 감지 (`messages.length > prevLen` + snapshot) → restoreAnchorScrollTop 결과로 `scrollTop` 복원
- B-2 WS append + bottom-near: `isNearBottom({ slack: 100 })` true → `scrollToIndex(N-1, 'end')`
- B-3 resize: virtualizer 가 ResizeObserver 로 자동 재측정
- B-4 row height 변동: `measureElement` 자동 + 위쪽 변동 시 B-1 snapshot 패턴 (단, edit-shrink 는 scope 밖 follow-up)

### C — 회귀 spec + Performance

- `apps/web/src/features/messages/messageAnchor.spec.ts` (12 unit tests) — snapshot/restore round-trip, isNearBottom 4 cases
- `apps/web/e2e/messages/virtualization.e2e.ts` (신규) — 1000 fixture seed → DOM `[data-testid="message-row"]` count ≤ 60 (visible + overscan\*2)
- `apps/web/e2e/messages/messagelist-anchor.e2e.ts` (신규) — B-1 history prepend / B-2 WS append 시뮬레이션

### Bundle delta

| chunk                 | 042 baseline | 043      | Δ gzip   |
| --------------------- | ------------ | -------- | -------- |
| initial entry + shell | 12.02 KB     | 12.03 KB | +0.01 KB |
| Shell chunk           | 17.26 KB     | 17.30 KB | +0.04 KB |
| MessageColumn (lazy)  | 13.10 KB     | 18.68 KB | +5.58 KB |

**Initial entry + Shell budget 영향 거의 없음** (dod target 충족: ≤ +5 KB gzip on initial+shell). MessageColumn 은 lazy chunk 이므로 첫 paint 영향 없음, react-virtual 라이브러리 비용 그 chunk 안에 흡수.

## Out of scope (follow-up)

- `MobileMessages.tsx` virtualization (별도 컴포넌트, swipe-reply / long-press / keyboard-dodge 다름 → `task-043-follow-mobile-virtualize`)
- Edit-shrink 후 위쪽 jump (`task-043-follow-edit-shrink-anchor`)
- Lighthouse-CI runtime metric 측정 (`task-040-follow-lighthouse-ci` 그대로)

## Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;
