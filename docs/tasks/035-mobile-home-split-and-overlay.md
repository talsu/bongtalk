# Task 035 — 034 Deferred Finalize: 모바일 Home Split + Overlay 채팅 → main deploy

## Context

034 가 Channel.workspaceId nullability cascade (6+ services) +
Activity standalone audit 를 closed 했지만 **모바일 UX 두 조각
E/F 는 여전히 deferred**:

- **E**: 모바일 Home screen split (왼쪽 workspace+DM rail + 오른쪽
  channel/friend list)
- **F**: 모바일 overlay 채팅 슬라이드 (채널/친구 선택 시 화면
  덮기 + ← back 으로 close)

현재 모바일 Home 화면은 033 의도와 다르게 기존 모습 유지. 035
는 이 두 건을 닫고 F-3 (Home = DMs + 친구 사이드바) 명세를
**완전 충족**.

Backend 는 034 에서 깔끔히 정리됐으므로 035 는 frontend-only
task. 1–1.5일 예상.

## Scope (IN) — 4 chunks

### E. 모바일 Home Screen Split

`apps/web/src/shell/mobile/MobileHome.tsx` 신규 또는 기존
`Shell` 의 모바일 분기 확장:

- Tabbar **Home 탭** 진입 시 grid layout 두 영역:
  - **왼쪽 narrow column (76px)** — workspace+DM rail:
    - 최상단: **DM 아이콘** (`qf-m-server-btn` 또는 기존 클래스
      조합 + Icon `message`)
    - workspace 아이콘 리스트
    - `+` 생성 버튼
    - `🔍` 찾기 버튼 (Icon `compass`)
  - **오른쪽 wider column** — 활성 컨텍스트:
    - DM 활성 (`/dm`) → 친구 목록
      - 상단 "친구" 메뉴 row (`qf-m-row` + Icon `users`, 클릭 →
        `/dm/friends` overlay)
      - 하단 친구 list (ACCEPTED 만, status 정렬: online → DnD →
        offline)
    - workspace 활성 (`/w/:slug`) → 채널 목록
      - 카테고리 헤더 (`qf-m-section`)
      - 채널 list (`qf-m-row`)
- 왼쪽 column 활성 항목 highlight (`qf-server-btn--active` 스타일
  적용)
- DS 규약: `mobile.css` 건드리지 않고 기존 `qf-m-*` 조합으로
  해결. 필요 시 inline style + DS 토큰 (`var(--s-*)`,
  `var(--w-*)`) 만 사용
- URL 기반 상태:
  - `/dm` or `/dm/friends` → DM 활성 + 우측 친구 목록
  - `/w/:slug` → workspace 활성 + 우측 채널 목록
- Tabbar 의 Home 탭 아이콘 활성 state (기존 로직 유지)

### F. 모바일 Overlay 채팅 슬라이드

- 채널 row 또는 친구 row 클릭 → 신규 `qf-m-overlay` 컴포넌트
  슬라이드 in:

  ```css
  /* inline style 또는 작은 component-scoped CSS (DS mobile.css 불침범) */
  .qf-m-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-chat);
    z-index: var(--z-overlay);
    transform: translateX(100%);
    transition: transform var(--dur-fast) var(--ease-out);
    will-change: transform;
  }
  .qf-m-overlay--open {
    transform: translateX(0);
  }
  ```

- Overlay 내용:
  - 기존 모바일 채팅 컴포넌트 (027 `MobileMessages` / DM chat)
    그대로 재사용
  - 좌측 상단 `qf-m-topbar__back` (`←` Icon `chevron-left`)
- 열기 flow:
  1. URL 변경 (`/w/:slug/c/:ch` or `/dm/:friendId`) + `history.pushState` entry 추가
  2. Overlay 컴포넌트 mount, `--open` class 없는 상태
  3. 다음 animation frame 에서 `--open` class 추가 → 슬라이드 in
- 닫기 flow (← button 또는 browser back):
  1. `--open` class 제거 → 슬라이드 out
  2. `transitionend` 이벤트 대기
  3. 애니메이션 종료 후 overlay unmount + URL 갱신
- **Underneath Home 유지**: React render 그대로 (overlay 가 z-index
  로 덮을 뿐). 복귀 시 scroll 위치 / state 보존
- browser back button handler 등록 (`popstate` listener) — overlay
  열린 상태에서 back 누르면 자연 close
- swipe-back gesture (iOS 느낌):
  - 왼쪽 edge (x < 20px) 에서 오른쪽으로 drag 시작 → overlay
    translate 따라 이동
  - drop 시 40px 이상 drag 또는 빠른 velocity → close, 아니면
    snap back
  - 024 의 `useSwipeHorizontal` 훅 재사용 가능하면 재사용

### G. E2E + 회귀

신규:

- `home-mobile-base.mobile.e2e.ts` (034 에서 scaffolded 되어 있으면
  implement 완성): 양 영역 DOM 존재 + DM/workspace 왼쪽 rail
  토글 시 오른쪽 컨텍스트 전환 검증
- `home-mobile-overlay.mobile.e2e.ts` (034 에서 scaffolded 완성):
  - 친구 또는 채널 선택 → overlay slide-in (CSS class 검증,
    visual diff 아닌 final state)
  - ← back → close → Home underneath 그대로 DOM 유지
  - `history.pushState` entry 생성 확인 (browser back 기능 검증)
- `home-mobile-swipe-back.mobile.e2e.ts` 신규 (F 의 swipe-back
  gesture):
  - overlay 열린 상태에서 왼쪽 edge 에서 오른쪽으로 drag 시뮬
  - 40px 이상 drag 시 close, 20px 이하 drag 시 snap back

기존 회귀:

- 024 의 mobile shell e2e 들이 MobileHome split 적용 후 green
- 027 의 mobile DM tab e2e 는 이미 tabbar 3탭으로 제거됐으므로
  영향 없음
- 026 의 mobile Activity e2e 는 tabbar 유지
- 가능하면 025 의 polish harness (14 mobile specs) 전부 green

### H. develop → main auto-promote + Pane 1 auto-forward 13th

표준 flow.

## Scope (OUT)

- 새 feature (Voice / Group DM / Custom emoji / Loki / PITR /
  mecab-ko)
- DS mobile.css 신규 클래스 추가 (이번 task 는 기존 클래스
  조합만으로 해결)
- Overlay 의 고급 transition (parallax / Y-axis + X-axis 혼합)
- iOS safari 의 edge swipe 와의 충돌 완벽 해결 (24 의 swipe-vs-edge
  패턴 재사용으로 충분)
- 033 완료 후 남은 작은 UX 정리 (027 workspace-scoped DM API
  완전 삭제 등)

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- `pnpm --filter @qufox/web test:e2e` green, 신규 3 specs (위 § G)
- 모바일 viewport 375×667 에서 Home split DOM 존재:
  - 왼쪽 narrow rail (width ≈ 76px)
  - 오른쪽 wider column (DM 활성 시 친구 목록 / workspace 활성
    시 채널 목록)
- 모바일 overlay animation CSS class 검증 (`.qf-m-overlay--open`
  적용 + `transition: transform` 존재)
- Overlay open 시 `history.length` 증가 + browser back 에 close
  동작
- Underneath Home render 유지 (overlay 닫으면 scroll 위치 복원)
- Swipe-back gesture: 40px+ drag 시 close / 20px 이하 snap back
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched (git diff 0)
- qf-m-\* 사용 카운트 증가 (기존 + Home split + Overlay, 280+
  예상)
- 3 artefacts: `035-*.md`, `035-*.PR.md`, `035-*.review.md`
- 1 eval 신규: `evals/tasks/046-mobile-home-split-overlay.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` (path `/volume2/dockers/qufox-deploy/.deploy/`)
  last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 13번째**
- FINAL REPORT 자동 출력, 포함:
  - develop/main SHA + exitCode + /readyz + idle + wall
  - 청크 E/F/G/H 산출물 표
  - **033 deferred 4건 전체 status** (A/I 는 034 closed, E/F 이번에
    closed) — F-3 완결 표기
  - 모바일 Home split + Overlay 동작 캡처 (스크린샷 또는 CSS
    class 적용 증거)
  - Swipe-back gesture 동작 증거
  - Deferred TODO(task-035-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 034 merged + deployed (`3a843ae` main)
- Backend Global DM 모델 (Channel.workspaceId nullable + CHECK +
  6 services nullable 수용) 활성
- 027/024 의 모바일 채팅 컴포넌트 (MobileMessages) 재사용 가능
- 024 의 `useSwipeHorizontal` 훅 (swipe gesture 재사용)
- DS `qf-m-screen`, `qf-m-row`, `qf-m-topbar__back`, `qf-m-server-btn`
  (있으면) 활용
- 026 의 모바일 `/activity` + 모바일 tabbar 활성

## Design Decisions

### Home rail 76px

024 데스크톱 server rail 과 비율 맞춤. 화면 폭의 ~20%. 정확값은
iOS/Android 실기기 viewport 에서 finalize; 초기값 76px.

### DS mobile.css 무침범

033/034 에서 "DS source of truth" 규약 유지. 필요하면 inline
style + tokens 만 사용. 신규 class 는 compositional 하게 기존
qf-m-_ 와 `var(--_)` 로 구성.

### Swipe-back 포함

모바일 UX 의 de-facto 표준. iOS 앱과 유사한 느낌 제공. 024 의
swipe 훅 재사용으로 비용 낮음.

### Overlay CSS-only (JS 애니메이션 없음)

framer-motion / react-spring 등 라이브러리 추가 시 번들 사이즈
증가. CSS transform 은 GPU-accelerated 로 60fps. `transitionend`
이벤트로 end of animation 감지 (React state 동기화).

### Browser back = overlay close

`history.pushState` 로 entry 추가 + `popstate` listener. iOS
Safari edge swipe 도 `popstate` 발생시키므로 동일 path.

### Underneath Home unmount X

React key 로 overlay 를 별도 subtree 로 분리. Home 의 tree 는
영향 없음. scroll 위치 / WS 연결 / 상태 보존.

## Non-goals

- Voice channel / Group DM / Custom emoji / Loki / PITR /
  mecab-ko
- DS mobile.css 수정
- 데스크톱 UX 변경 (033 에서 완성)
- 027 workspace-scoped DM API 삭제
- Performance optimization beyond CSS transform
- Overlay 내 고급 gesture (swipe-dismiss-up 등)

## Risks

- **iOS safari edge swipe 가 browser back 으로 동작할 때와
  overlay swipe-back 의 충돌**: 024 의 패턴 그대로 적용 (edge
  < 20px 만 처리, native back 은 popstate 로 자연 close). 이미
  detected edge cases
- **`visualViewport` + overlay transform**: iOS 키보드 올라올
  때 overlay 의 transform base 가 영향 받을 수 있음. 024 의
  keyboard dodge 와 동작 검증
- **swipe gesture 도중 overlay close 상태 race**: user 가 drag
  중에 browser back 호출 시 double close. handle 에서 idempotent
  처리
- **workspace list 가 많아지면 좌측 rail overflow**: 서버 rail
  이 세로 스크롤 되게 (`overflow-y: auto`) + tabbar 위까지
  fade-out 안전 처리. 025 에서 데스크톱 server rail 이 이미
  해결한 방식 재사용
- **Home underneath render 유지 cost**: 채팅 overlay 열려있을 때
  underneath 의 WS event listener / React Query cache 가 계속
  active. 배터리 / 네트워크 영향 측정은 아니지만 개발자 console
  memory check 권장. 이번 task 의 scope 는 아님
- **034 의 6 services cascade 와 상호 작용**: MobileHome 가 unread
  / friend list 가져올 때 034 의 nullable 수용이 잘 동작하는지
  확인. 025 polish harness 녹색으로 유지

## Progress Log

_Implementer 채움_

- [ ] UNDERSTAND (024 `useSwipeHorizontal` 시그니처, 027
      `MobileMessages` 재사용 가능 영역, 033/034 의 데스크톱 DM
      shell 에 영향 없는지 검증, DS 에 `qf-m-server-btn`
      `qf-m-overlay` 유무)
- [ ] PLAN approved
- [ ] SCAFFOLD (MobileHome split skeleton, MobileOverlay 컴포넌트
      skeleton, 3 e2e specs red)
- [ ] IMPLEMENT (E → F → G)
- [ ] VERIFY (`pnpm verify` + GHA e2e green + 모바일 viewport
      screenshot 캡처)
- [ ] OBSERVE (375×667 에서 split DOM 검증, overlay CSS class
      전환 검증, swipe-back 40px threshold 증거, history.pushState
      entry 증거)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT auto-printed + **pane 1 auto-forwarded 13th**
      with F-3 완결 표기)
