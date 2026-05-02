# Task 043 — Message List Virtualization (react-virtual) → main deploy

## Context

040 R6 (Channel messages) 와 R8 (Performance) 에서 deferred 된
`task-040-follow-virtualization`. 현재 메시지 list 는 모든 row 를
DOM 에 mount 한다. prod 에서 메시지 누적 시:

- DOM node 폭증 → memory + paint 시간 증가
- scroll FPS 저하 (특히 모바일)
- 첫 paint 가 늦음 (history 100+ 메시지 한 번에 mount)

`@tanstack/react-virtual` 도입으로 단일 큰 개선. 채널 메시지 list +
DM 메시지 list (보통 같은 컴포넌트) 한 번에 cover.

## Scope (IN) — 3 chunks

### A. @tanstack/react-virtual 도입 + MessageList 변환

- 의존성: `@tanstack/react-virtual` (이미 사용 중인지 grep)
  - 미사용 시 `apps/web/package.json` 추가, lockfile 갱신
- 대상 컴포넌트: `apps/web/src/features/messages/MessageList.tsx`
  (또는 동등 — 채널 + DM 공통). 다른 path 면 grep 으로 확정.
- Virtualizer 구성:
  - `useVirtualizer({
  count: messages.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => 64,         // 기본 row height 추정
  measureElement: el => el.getBoundingClientRect().height,
  overscan: 8,
})`
  - row container 에 `ref={virtualizer.measureElement}` 부착
  - 가변 높이 (메시지 텍스트 길이 / 첨부 / 리액션 / 코드블록 / URL preview)
- 데스크톱 + 모바일 동일 컴포넌트 → single change. 별도면 두 컴포넌트
  모두 적용
- Reverse 방향 정합성 확인:
  - 위로 스크롤 = older history. virtualizer index 0 이 oldest 인지
    newest 인지 코드 확인 후 적용
  - 일반적으로 oldest first (index 0 = 가장 위). bottom 은 마지막 index

### B. Anchor scroll behavior

자체가 핵심. 4가지 시나리오:

**B-1. History load (older 메시지 prepend)**

- 사용자가 위로 스크롤 → older fetch → 새 메시지 prepend
- naive 처리: scrollTop = 0 으로 jump (사용자 시야 깨짐)
- 해법: prepend 직전 첫 visible 메시지의 (id, scrollOffset) 기록
  → prepend 후 동일 메시지의 새 scrollOffset 으로 보정
- `useEffect` 안에서 virtualizer.scrollToIndex(savedIndex, {
  align: 'start', behavior: 'auto' })

**B-2. WS append (new 메시지 push)**

- 사용자가 bottom near (≤ 100px) → auto scroll-to-bottom
- 사용자가 위 영역 → unread badge 표시 + scroll 유지
- bottom 판정: `(scrollHeight - scrollTop - clientHeight) ≤ 100`
- 기존 unread 인디케이터 / new-message divider 가 있다면 그 동작 유지

**B-3. Resize (모바일 address-bar collapse / orientation)**

- viewport 높이 변경 → virtualizer 가 자동 재계산
- 마지막 visible 메시지 anchor → 보정 (B-1 와 같은 패턴)

**B-4. Row height 변동**

- 이미지 lazy-load 완료 → height 증가
- Reaction toggle (추가/제거) → height 변동
- Edit 후 텍스트 길이 변동 → height 변동
- `measureElement` 가 자동 재측정. 단 위쪽 row 가 변동되면 아래
  row 들 scrollTop 변동 → B-1 패턴으로 anchor 보정 필요

### C. 회귀 spec + Performance 측정

**E2E:**

- `apps/web/e2e/messages/virtualization.e2e.ts`
  - 1000 메시지 fixture seed (BE seed 또는 fixture API)
  - 채널 진입 → DOM 의 `[data-testid="message-row"]` count ≤ 50
    (visible window + overscan 8 × 2)
  - scroll-to-top → DOM count 그대로 + index 0 visible
  - scroll back to bottom → bottom 메시지 visible
- `messagelist-anchor.e2e.ts`
  - History load (older) → 첫 visible 메시지가 prepend 후에도 같은
    위치 (scrollOffset diff ≤ 5px)
  - WS append + bottom-near → auto scroll
  - WS append + scrolled-up → unread badge + scroll 유지

**Unit:**

- `useMessageVirtualizer.spec.ts`
  - estimateSize / measureElement 호출 횟수 + 가변 height 처리
- `messageAnchor.spec.ts`
  - prepend 시 anchor 보정 함수 (보정 px 계산)

**Performance:**

- `vite build` bundle delta vs 042 baseline (`7a86bd3`)
  - react-virtual 추가 비용 ≤ +5 KB gzip 목표
- DOM node count baseline (1000 메시지 fixture) before/after
  - before: ≥ 1000 row nodes
  - after: ≤ 50 row nodes
- scroll FPS Performance API stopwatch (정성, 정량은 lhci 부재로
  follow-up)

### D. develop → main auto-promote + Pane 1 auto-forward 21번째

표준 flow.

## Scope (OUT)

- DM list (workspaceless DM 채널 list 자체) — 100개 cap 이라 OUT
- Notification list / Activity feed virtualize — 별도
- 새 feature
- DS 4파일 수정
- Lighthouse CI 인프라 (별도 task 미래)
- 메시지 컴포넌트 자체 디자인 변경 (rich content / reaction UI)
- BE 변경 (메시지 페이지네이션 사이즈 등)
- E2E framework 변경
- React 19 migration 같은 큰 의존성 변경

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- **A 검증**:
  - `@tanstack/react-virtual` 의존성 추가 또는 기존 사용 (lockfile 변경 확인)
  - `MessageList.tsx` virtualizer 적용 (`useVirtualizer` import)
  - 데스크톱 + 모바일 viewport 모두 작동 (수동 또는 e2e)
- **B 검증**:
  - History load anchor: 첫 visible 메시지 scrollOffset diff ≤ 5px
  - WS append: bottom-near 시 auto, 위쪽 시 unread badge
  - Resize: viewport 변경 후 마지막 visible 메시지 유지
  - Row height 변동 (이미지 / reaction / edit) 후 layout 깨짐 없음
- **C 검증**:
  - 1000 메시지 fixture e2e: DOM row node ≤ 50
  - Anchor e2e green
  - Bundle delta ≤ +5 KB gzip
  - DOM node before/after 기록
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched (`git diff` 0)
- 3 artefacts: `043-*.md`, `043-*.PR.md`, `043-*.review.md`
- 1 eval: `evals/tasks/053-virtualization.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` 위치는 `/volume2/dockers/qufox-deploy/.deploy/audit.jsonl`
  (memory: `reference_deploy_audit_location.md`) — last entry `exitCode=0`
  - sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 21번째**
- FINAL REPORT 자동 출력, 포함:
  - develop/main SHA + exitCode + /readyz + idle + wall clock
  - 청크 A~C 산출물 표
  - DOM node count before/after (1000 메시지 fixture)
  - Bundle delta vs 042 baseline (chunk 별)
  - Anchor scroll e2e 결과 (4 시나리오)
  - Performance stopwatch (scroll FPS 체감)
  - 데스크톱 + 모바일 capture (1000 메시지 진입 시)
  - Deferred TODO(task-043-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 040 (PL4, `037c71d`) + 041 (sweep, `17c8ab4`) + 042 (PL5, `7a86bd3`)
  merged + deployed
- MessageList 의 채널 + DM 공유 구조 (또는 별도 구조 — UNDERSTAND
  단계에서 확정)
- 040 R3 ConnectionBanner / 041 sendFailureToast / 042 R0 presence-memo
  안정
- 028 polish harness (회귀 guard)

## Design Decisions

### react-virtual 채택

- 활발한 유지보수 (TanStack)
- 가변 높이 measureElement 지원
- React 18 strict mode 호환
- 작은 bundle (~5 KB gzip)
- 대안 react-window 는 가변 높이 제한적

### Virtualizer 의 reverse 방향

채팅 list 는 보통 oldest first (위) → newest last (아래). virtualizer
의 index 도 동일. bottom 은 마지막 index 로 scroll. reverse 모드
(`useVirtualizer({ ... })` 자체엔 reverse 옵션 없음, 일반 방향 유지)
사용 안 함.

### Anchor 알고리즘 (B-1)

가장 까다로운 부분. 패턴:

1. fetch older 시작 직전: `firstVisibleId = messages[firstVisibleIndex].id`
   - `firstVisibleOffset = scrollTop - virtualItem.start`
2. fetch 완료 후: 같은 id 의 새 index 찾기 + virtualizer 의 새
   start 가져오기 + scrollTop = newStart + firstVisibleOffset
3. 동기 setState + scrollTo (layout effect)

### B-2 의 bottom 판정 100px

너무 작으면 마지막 메시지 끝 5px 아래에서 unread 가 뜸 (사용자
의도와 다름). 100px 정도가 직관적 — 화면 하단 1-2 메시지 분량.

### measureElement throttle 안 함

react-virtual 이 ResizeObserver 로 자동 처리. 추가 throttle 불필요.

### Bundle 비용

react-virtual ~5 KB gzip + 우리 wrapper ~2 KB 기대. 040 baseline
대비 +0.5% 이내 예상.

### 1000 메시지 fixture seed

BE 의 message seed API 사용 또는 e2e setup 에서 직접 Prisma.
seed 후 메시지 fetch + DOM count 검증.

### Edit 후 height 축소

가장 까다로운 edge case. 위쪽 row 가 줄어들면 아래 row 들이 위로
당겨짐 — scrollTop 변동. 사용자가 bottom 에 있었다면 자연스럽지만
중간이면 jump 느낌. 단, 본인이 edit 한 경우라 본인 화면에 보이는
중. 일반 사용자 시각 jump 는 드물 (다른 사용자 메시지 edit 빈도
낮음). 일단 measureElement 자동 재계산 + B-1 anchor 미적용
(jump 허용). follow-up 으로 두기.

### DM 채널 list 자체는 OUT

현재 DM 채널 cap 100. virtualize 의 의미 적음 + UI 패턴 다름
(side panel vs main scroll area). 별도 task 도 우선순위 낮음.

## Non-goals

- DM 채널 list virtualize
- Notification / Activity virtualize
- 메시지 컴포넌트 디자인 변경
- 메시지 자체 BE pagination 변경
- React 19 / 큰 의존성 변경
- DS 4파일 수정
- 새 feature
- 새 컴포넌트
- 모든 list virtualize 통합 라이브러리

## Risks

- **Anchor 알고리즘 미세 jump**: prepend 후 1-2px scroll diff 가
  사용자 시각으로 인지될 수 있음. e2e tolerance 5px 이내, 실패
  시 alignment 조정
- **measureElement 비용**: 1000 row 라도 visible 만 측정 — 안전
- **이미지 lazy-load 후 height 증가**: 위쪽 이미지가 늦게 로드되면
  아래 시야 jump. `<img loading="lazy">` 의 height 사전 지정 또는
  aspect-ratio CSS 로 안정. 첨부 메타에 height 정보 있으면 사용
- **Reaction toggle race**: 사용자가 reaction 추가하는 순간 list
  prepend 발생하면 height 측정 race. React batching 으로 보통
  안전, 그러나 e2e 시뮬 어려움 → unit 으로 cover
- **모바일 momentum scroll + virtualizer**: iOS Safari 의 momentum
  이 native 인데 react-virtual 의 scroll listener 가 throttle 부족
  하면 첫 row paint 지연. overscan 8 로 buffer 넉넉히
- **Bundle 비용 초과 (+5 KB)**: react-virtual + wrapper 가 의외로
  크면 follow-up 으로 dynamic import 검토
- **Edit 후 위쪽 jump**: 본인 edit 빈도 낮아 follow-up 이월
- **회귀 spec fixture seed 시간**: 1000 메시지 BE seed 가 30s+ 일
  수 있음. e2e setup 에서 분리 + skip 옵션 고려
- **virtualized row 의 hover actions**: hover 시 reaction picker
  같은 popover 가 row 밖으로 튀어나오면 DOM 위치 어색함. e2e 확인
- **Edit overlay 가 virtualized row 와 겹침**: 041 의 edit/delete
  skeleton 동작이 measureElement 트리거 시 시각 깜박임. 수동 확인
- **Anchor 알고리즘 strict mode 이중 effect**: layout effect 가
  두 번 실행 → scrollTo 두 번. idempotent 하게 작성

## Progress Log

_Implementer 채움_

- [ ] UNDERSTAND (MessageList 위치 확정 / 채널 + DM 공유 구조 /
      현재 history fetch trigger / WS append 흐름 / 042 R0 F2
      presence-memo 와 충돌 가능성 / 첨부 메타 height 정보)
- [ ] PLAN approved
- [ ] SCAFFOLD (의존성 add red, virtualizer skeleton, anchor 보정
      stub, 1000 메시지 fixture stub)
- [ ] IMPLEMENT (A → B → C)
- [ ] VERIFY (`pnpm verify` + e2e green + bundle delta 측정 + DOM
      count 측정)
- [ ] OBSERVE (DOM count before/after, bundle delta, anchor 4 시나리오
      capture, scroll FPS 체감 stopwatch)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook → FINAL
      REPORT auto-printed + **pane 1 auto-forwarded 21st**)
