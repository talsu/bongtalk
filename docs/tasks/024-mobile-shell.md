# Task 024 — Mobile Shell (DS mobile.css + qf-m-\* 전면 활용) → main deploy

## Context

DS mobile 자산은 완비됐지만 (`apps/web/public/design-system/mobile.css`
361줄, 100+ `qf-m-*` 클래스, iOS 기반 React 목업, mobile tokens
`--m-topbar-h` / `--m-tabbar-h` / `--m-composer-h` / `--m-touch`
/ `--m-gutter` / `--m-sheet-r`), 실제 앱에서는 `qf-m-*` 사용이
**0건**입니다. 모바일 viewport에서 앱을 열면 데스크톱 4-column
shell이 그대로 눌리면서 사실상 사용 불가.

Task 024는 DS의 `mobile.css` + `qf-m-*` 클래스를 **조립 재료로
그대로 쓰고** 새 CSS를 최소화하는 방향으로 모바일 shell을 신축
합니다. 데스크톱 코드는 건드리지 않고 viewport breakpoint로
분기. 023에서 webhook 파이프라인이 복구됐으므로 이 task가
**진짜 webhook 경로로 prod에 배포되는 첫 feature task**입니다.

## Breakpoint + 전환 원칙

- `< 768px` (Tailwind `md` 미만) → `MobileShell` 렌더
- `>= 768px` → 기존 `Shell` (데스크톱 4-column) 유지
- 분기 경계에서 React remount 허용 (단순성 우선; reactive
  reorg를 강요하지 않음)
- URL 구조 동일: `/w/:slug`, `/w/:slug/c/:channelName`,
  `?thread=<id>` 전부 그대로. 모바일은 URL 기반으로 뷰를
  토글.

## Scope (IN) — 9 chunks

### A. Viewport 분기 + `useBreakpoint`

- 새 훅 `apps/web/src/hooks/useBreakpoint.ts`:
  - `matchMedia('(max-width: 767px)')` 구독
  - `mobile | desktop` 반환
  - SSR safe (초기값은 URL hint 없으므로 desktop; first paint 후
    재계산)
- `apps/web/src/shell/Shell.tsx` 상단에서:
  ```tsx
  const bp = useBreakpoint();
  if (bp === 'mobile') return <MobileShell ... />;
  // 기존 desktop 분기 유지
  ```
- 데스크톱 코드는 **한 줄도 수정하지 않음** (분기만 앞에 추가).

### B. Mobile shell 골조

- 새 `apps/web/src/shell/mobile/MobileShell.tsx`:
  - 라우트 상태 읽어 5가지 뷰 중 하나 렌더:
    1. **워크스페이스 선택 없음** (`/` 또는 `/w/new`) → 기존
       auth/create/invite 페이지들은 viewport 무관 동작
    2. **채널 리스트** (`/w/:slug`, 채널 미선택) → `qf-m-screen`
       안에 `qf-m-topbar` (워크스페이스 명 + 햄버거) + channel
       list body (`qf-m-row` 반복) + `qf-m-tabbar`
    3. **메시지** (`/w/:slug/c/:ch`) → `qf-m-screen` (topbar +
       메시지 body + `qf-m-composer` + `qf-m-tabbar`)
    4. **스레드** (`?thread=<id>`) → 풀스크린 `qf-m-screen`
       (topbar back + 스레드 body + composer)
    5. **설정** (`/settings/*`) → 기존 데스크톱 설정 페이지에
       topbar만 mobile로 감쌈 (019 설정 UI 재사용)
- 공통: `qf-m-screen`이 flex column, topbar/body/composer/tabbar
  순서.

### C. 채널 리스트 화면 + 좌측 drawer

- 채널 리스트 본문: 카테고리(disclosure) + 채널(`qf-m-row`
  per channel). 아이콘은 `#` / `🔊` / `📢` (DS `icons.svg` 활용)
- Topbar 좌측 `☰` (햄버거) 탭 → **좌측 drawer** 슬라이드:
  - 드로어 헤더: 현재 사용자 avatar + 이름 + 상태 dot
  - 서버(workspace) 리스트: `qf-m-row` (아이콘 + 이름 + unread
    badge)
  - 하단: `+` 새 워크스페이스 / 설정 / 로그아웃
- Drawer 오픈 상태: 오버레이 + `transform: translateX(0)`,
  백드롭 클릭 또는 ESC로 닫힘
- Drawer 컴포넌트는 DS의 `qf-m-sheet` 변형 또는 커스텀 transform
  (DS에 drawer 클래스가 없다면 tokens로 만듦 — 단, 선택 먼저는
  `qf-m-*` 재활용이어야)

### D. 메시지 화면 + `qf-m-composer`

- 메시지 body: 기존 `MessageList` 재사용 (모바일 viewport에서도
  가상 스크롤 작동 확인)
- 하단 composer: 기존 `MessageComposer` 내부를 그대로 쓰되
  래핑 컨테이너를 `qf-m-composer`로 교체
  - `+` 버튼 → 기존 attach / emoji / thread reply 메뉴 (모바일은
    `qf-m-sheet`로 띄움)
  - textarea → `qf-m-composer__input` (auto-grow 동작 유지)
  - `➤` 전송 버튼 → `qf-m-composer__send`
- safe-area inset:
  - `padding-bottom: env(safe-area-inset-bottom)` (DS tokens에
    이미 내장)
- Topbar:
  - 좌측 `←` back (`qf-m-topbar__back`) — 채널 리스트로
  - 가운데 채널명 + topic (`qf-m-topbar__titleBlock`)
  - 우측 `👥` member drawer 토글

### E. 멤버 drawer (우측)

- 채널 화면 topbar의 `👥` → **우측 drawer** 슬라이드
- 내용: 온라인/오프라인 그룹 헤딩 + `qf-m-row` 멤버 리스트
- 클릭 → 프로필 카드 (`qf-m-sheet`로 띄움 — 베타는 정보 표시만,
  DM 진입은 OUT)
- 데스크톱 `MemberColumn` 로직 재사용 (데이터 훅 동일)

### F. Long-press context menu + swipe-to-reply

- **Long-press (500ms)** on message → `qf-m-sheet` 띄움:
  - 반응 이모지 row (quick picker 6개 + "+" 더보기)
  - 액션 리스트: 답글 / 복사 / 편집 (내 메시지만) / 삭제 (내/
    권한) / 핀 (권한)
  - 시트 내 액션은 데스크톱 toolbar 로직 재사용
- **Swipe right to reply** (터치 시작 → 우측으로 40px 이상) →
  composer가 "답글 모드" 진입 (thread 또는 in-channel reply는
  훅의 기존 decision 유지)
- 구현:
  - `useLongPress()` + `useSwipeHorizontal()` 신규 훅
    (`apps/web/src/hooks/`)
  - 터치 이벤트만 활성 (`matchMedia('(pointer: coarse)')` 또는
    viewport 기반)

### G. `qf-m-tabbar` — 4탭

- 바닥 네비 4탭: **Home · DMs · Activity · You**
- Home: 현재 워크스페이스 채널 리스트 (`/w/:slug`)
- DMs: `disabled` — 터치 시 "곧 제공 예정" 토스트
- Activity: `disabled` — 동일
- You: `/settings` 진입
- `qf-m-tabbar` 클래스 + 아이콘은 DS `icons.svg` 활용
- 활성 탭은 DS의 `--a-500` accent
- safe-area 자동 (DS 기본)

### H. 키보드 dodge (iOS Safari / Android)

- composer가 포커스될 때 키보드가 올라옴 → composer는 키보드
  위에 붙어야
- `visualViewport.resize` 이벤트로 effective viewport height
  추적 → composer의 `bottom` 오프셋 동적 조정
- `-webkit-fill-available` + `100dvh` 조합으로 초기 height
  안정화
- `useKeyboardDodge()` 훅 신규 (`apps/web/src/hooks/`)
- 본문(`qf-m-body`)은 키보드 올라올 때 자동 축소, 스크롤 위치
  유지 (바닥에 있었으면 바닥 유지)

### I. Mobile E2E + VR + Polish

- 신규 `apps/web/e2e/mobile/` 디렉토리:
  - `mobile-shell-switch.mobile.e2e.ts` — viewport 375 vs 1280
    에서 Shell이 올바르게 분기
  - `mobile-channel-drawer.mobile.e2e.ts` — 햄버거 → drawer 열기
    → 워크스페이스 전환
  - `mobile-message-flow.mobile.e2e.ts` — 채널 진입 → 메시지
    전송 → scroll behavior
  - `mobile-longpress-sheet.mobile.e2e.ts` — 메시지 long-press
    → 시트 액션
  - `mobile-swipe-reply.mobile.e2e.ts` — 오른쪽 스와이프 → 답글
    모드
  - `mobile-member-drawer.mobile.e2e.ts` — 👥 → 우측 drawer
  - `mobile-tabbar.mobile.e2e.ts` — 4탭 동작 + disabled 피드백
- `mobile-vr-parity.mobile.e2e.ts` (Playwright `toHaveScreenshot`):
  - viewport 375×667 (iPhone SE) + 390×844 (iPhone 14) 2종
  - `/design-system/index.html#mobile` 의 iOS 목업과 parity
    (diff ≤ 3% — sub-pixel tolerance 좀 더 넉넉)
- 018의 polish harness는 데스크톱 viewport라 건드리지 않음
- 022의 14-harness도 데스크톱 전제 → 그대로 유지

## Scope (OUT)

- DM 실제 기능 (탭은 disabled)
- Activity 탭 실제 기능 (= mention inbox 페이지)
- FAB (`qf-m-fab`) 실제 action
- `qf-m-voice` 보이스룸
- iOS native app / PWA installation prompt
- Android specifics beyond pointer coarse detection
- 기존 데스크톱 shell 리팩토링
- DS mobile.css 수정 (memory DS-source-of-truth 유지)

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- `grep -rn 'qf-m-' apps/web/src/` returns **≥ 50 lines** (DS
  활용 지표)
- `pnpm --filter @qufox/web test:e2e` green on GHA:
  - `mobile/mobile-shell-switch.mobile.e2e.ts`
  - `mobile/mobile-channel-drawer.mobile.e2e.ts`
  - `mobile/mobile-message-flow.mobile.e2e.ts`
  - `mobile/mobile-longpress-sheet.mobile.e2e.ts`
  - `mobile/mobile-swipe-reply.mobile.e2e.ts`
  - `mobile/mobile-member-drawer.mobile.e2e.ts`
  - `mobile/mobile-tabbar.mobile.e2e.ts`
  - `mobile/mobile-vr-parity.mobile.e2e.ts` (light + dark)
- 데스크톱 e2e 전부 회귀 없음 (18 / 21 / 22 harness + 기존
  feature e2e)
- ESLint 규칙(018 팔레트 + raw cleanup)에 모바일 신규 코드
  위반 0건
- 3 artefacts: `024-*.md`, `024-*.PR.md`, `024-*.review.md`
- 1 eval 신규: `evals/tasks/037-mobile-shell-parity.yaml`
- Reviewer subagent 실제 스폰, transcript token count 기록
- **진짜 webhook 경로로** develop → main 자동 promote + deploy
  검증 (023 복구 후 첫 feature task)
- `.deploy/audit.jsonl` 마지막 entry `exitCode=0` + sha 일치
  (operator-tree 아니라 `/volume2/dockers/qufox-deploy/.deploy/`
  쪽을 참조)
- `GET https://qufox.com/api/readyz` = 200 + idle-window 30s
- **Pane 1 auto-forward** (FINAL REPORT 요약 1줄) —
  `feedback_pane0_auto_forward_report.md` 두 번째 적용
- FINAL REPORT 자동 출력, 포함 항목: develop SHA + main SHA +
  deploy exitCode + /readyz + idle-window + Wall + 청크별
  A–I 산출물 표 + qf-m-_ 사용 count + VR diff 결과 + Deferred
  TODO(task-024-follow-_)
- Feature branch retained

## Prerequisite outcomes

- 023 merged + deployed via webhook (audit.jsonl on
  `/volume2/dockers/qufox-deploy/.deploy/` 살아있음)
- heartbeat guard 가 24h threshold로 live
- DS: `mobile.css`, `icons.svg`, `mobile-mockups.jsx`,
  `ios-frame.jsx` 존재 (현재 상태 검증됨)
- 018–022의 데스크톱 DS parity + polish 수렴 상태
- `feedback_pane0_auto_forward_report.md` + `feedback_auto_promote_to_main.md`
  메모리 적용

## Design Decisions

### DS 자산 그대로 조립, 새 CSS 최소

`mobile.css`에 이미 topbar / tabbar / composer / sheet / row /
segment / fab / voice 전부 있음. 새 컴포넌트 TSX는 **className
조합**으로 끝남. 새 CSS는 drawer open/close transform 정도만
필요하고 그마저도 tokens(`--dur-*`, `--ease-*`)로 표현.

### 데스크톱 코드 무수정

viewport `<768` 이면 `MobileShell` 반환, 이상이면 `Shell` 기존.
Shell 내부 수정은 분기 add만 (1 import + 2 line).

### Breakpoint < 768 (md)

태블릿 portrait(768–1023)은 데스크톱 4-column 가능. Discord도
동일. 768이 진짜 모바일.

### URL 기반 네비게이션

라우트 구조 그대로. 모바일은 URL이 바뀔 때마다 적절한 view
선택 (채널 리스트 / 메시지 / 스레드 / 설정). pushState /
browser back 자연 동작.

### Long-press + swipe는 이번 task 포함

두 패턴은 DS 규칙에 명시됐고 (`index.html#mobile` 규칙
섹션) 모바일 UX의 기본 기대값. 한 task로 묶는 게 마감감 있음.

### Transition 시 remount 허용

`useBreakpoint` 결과가 바뀌면 `MobileShell` ↔ `Shell`이 서로
mount/unmount. 사용자가 기기 회전 중 실제로 이 분기를 넘는
경우는 드물고, 넘을 때 state reset은 허용 가능한 단순화.

### Pane 1 auto-forward 재적용

023 첫 적용이 성공했으므로 024부터 default. handoff prompt에
명시.

## Non-goals

- DM / Activity 탭 실제 구현
- FAB 의 실제 흐름
- 보이스 / 비디오 / 화면공유
- 모바일 native app / PWA install prompt
- Tablet 특화 레이아웃 (768–1023)
- 데스크톱 shell 리디자인

## Risks

- **`MessageList` 가상 스크롤이 모바일 viewport에서 다르게
  동작** — Intersection observer / scroll momentum은 모바일 쪽
  이 더 거칠 수 있음. Mitigation: `mobile-message-flow` e2e에
  scroll 시나리오 포함, 필요 시 `passive: true` 이벤트 리스너
  확인.
- **`visualViewport` 브라우저 지원** — Safari 13+ / Chrome 61+
  대부분 OK. 옛 WebView는 fallback(현재 동작)으로 렌더 — polish
  문제지 기능 blocker 아님.
- **long-press vs scroll 제스처 충돌** — 메시지 long-press
  시작 후 손가락이 움직이면 스크롤로 전환해야. `useLongPress`
  는 `touchmove` 발생 시 취소 로직 필수.
- **swipe-right vs 브라우저 뒤로가기** — iOS Safari의 edge
  swipe는 시스템 예약. 메시지 swipe 감지는 **메시지 row 내부
  에서만** 활성 + edge(x < 20px) 제외.
- **keyboard dodge가 Android Chrome에서 이중 보정** — Android
  는 viewport resize도 같이 일어남. 이중 subscription 주의;
  `visualViewport.resize`만 신뢰.
- **Drawer open state가 URL에 없음** — browser back이 drawer
  닫기 대신 이전 URL로 감. 사용자 이탈 가능성. Mitigation:
  drawer 열림 시 `history.pushState({ drawer: 'left' })` → back
  버튼으로 drawer만 닫히게.
- **VR parity 3% threshold** — iOS 목업은 React umd로 클라이언트
  렌더되는데 실제 Shell은 build된 TSX. 폰트/렌더 엔진 차이
  2–3% 수준. 3% 못 맞추면 baseline 재생성 + threshold 조정.
- **DS mockup은 예시 — 실제 데이터는 seed 필요** — 018 VR
  test에서 사용한 seed 패턴 재사용.
- **023 webhook 복구 이후 첫 feature deploy** — 023이 복구는
  했지만 feature 변경 없는 smoke만 돌았음. 024 실제 파일
  변경량은 큼 → rebuild 시간 길 수도. 3–5분 deploy 타임 허용.
- **Pane 1 auto-forward 실패 시** — 023은 성공했지만 tmux pane
  state가 달라질 가능성. handoff에 "paste-buffer 실패 시 pane
  0 자기 터미널에 [WARN] 출력" 명시.

## Progress Log

(implementer 채움)

- [ ] UNDERSTAND (mobile.css 클래스 목록 최종 확인, DS icons
      매핑, 023 webhook 상태 재확인, visualViewport 브라우저
      지원 확인)
- [ ] PLAN approved
- [ ] SCAFFOLD (useBreakpoint / useLongPress / useSwipeHorizontal
      / useKeyboardDodge 훅 stub, MobileShell 껍데기, 3 e2e
      skeleton)
- [ ] IMPLEMENT (A → B → C → D → E → F → G → H → I)
- [ ] VERIFY (`pnpm verify` + GHA e2e green + mobile VR
      baseline 커밋)
- [ ] OBSERVE (mobile shell screenshot 실제 기기/에뮬에서
      확인, qf-m-\* grep count 기록, VR diff 수치 기록)
- [ ] REFACTOR
- [ ] REPORT (develop merge → **진짜 webhook 경로로** main
      auto-promote → FINAL REPORT 자동 출력 + **pane 1
      auto-forward**)
