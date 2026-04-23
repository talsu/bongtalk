# Task 033 — F-3 Home Restructure: Global DM + "DM" 버튼 + 모바일 Overlay + Activity/Settings 분리 → main deploy

## Context

`feature-backlog.md` 의 **F-3** + 사용자 명세 (2026-04-23):

**Home 정의 (기본):** workspace list 가 보이는 base state. URL 페이지가 아니라 앱의 기본 화면 자체.

- **PC**: 로그인 후 항상 Home. 서버 레일 최상단 버튼 = **"DM" 버튼** (이전 명세의 "Home" 명칭 폐기). Workspace + DM workspace 같은 위상으로 server rail 에 list. 활성 항목에 따라 좌측 채널/친구 list + 우측 메시지 영역 분기.
- **Mobile**: Tabbar **Home 탭** = home screen 자체. Layout = 왼쪽 narrow workspace+DM list + 오른쪽 channel/friend list. 채널/친구 선택 시 메시지 영역이 **overlay 로 화면 덮음** (이동 아닌 덮음). ← 로 overlay 우측 슬라이드 out → 밑 Home 그대로.

**DM 모델:** **Global** (workspace 무관). 027 의 workspace-scoped DM 은 API deprecated 하고 UI 제거. 친구 기반 DM 만 활성.

**Activity / Settings:** 둘 다 `/activity` `/settings/*` 전체 화면 별도 페이지.

- 데스크톱: 좌측 하단 프로필 dropdown 에 두 메뉴 (`Activity` 신규 + 기존 `Settings`) 추가
- 모바일: tabbar 직접 진입. **3탭 = Home / Activity / Settings** (027 DMs 탭 제거, 016 You 탭 → Settings 명칭/route 정리)

## Scope (IN) — 11 chunks

### A. Global DM 모델

- Prisma migration (reversible):
  - `Channel.workspaceId` 를 nullable 로 변경
  - 추가 invariant: `Channel.type=DIRECT AND workspaceId=null` 인 row 가 가능. `type != DIRECT AND workspaceId IS NOT NULL` (TEXT/VOICE 등은 무조건 workspace 필수). DB CHECK constraint 가 가능하면 `CHECK ((type='DIRECT') OR workspaceId IS NOT NULL)` 추가; 어려우면 service 레벨 검증
- `DirectMessageService.createOrGet` 시그니처 확장:
  - `(meId, otherUserId, workspaceId?: string | null)` — workspaceId 누락 시 global DM
  - 친구 검증: 친구가 아닌 사용자와 DM 시도 → 403 `FRIEND_REQUIRED` (032 의 `Friendship` ACCEPTED 확인)
  - 차단된 사용자 → 403 `FRIEND_BLOCKED` (양방향 어느 쪽이라도)
- 027 의 `ChannelAccessGuard` DIRECT 분기 (027-BLOCKER-1 fix) 그대로 유효; workspaceId 무관

### B. Global DM API

- 신규 엔드포인트:
  - **`GET /me/dms?cursor&limit=50`** — 친구와의 DM 채널 list (last activity desc, unread count, lastMessage preview, friend.user info)
  - **`POST /me/dms`** body `{ friendId }` → friend-based createOrGet (workspaceId=null)
- 027 의 `/me/workspaces/:wsId/dms` endpoints:
  - 작동 유지 (호출 site 가 다음 cleanup task 까지 살아있을 수 있음)
  - response header `Deprecation: true` + `Sunset: <future date>` 추가
  - log/metric 기록 (호출 횟수 추적 → 다음 cleanup task 가 안전하게 제거)
- Rate limit: `POST /me/dms` 10/min/user

### C. 데스크톱 Server rail "DM" 버튼

- 서버 레일 최상단에 **"DM" 버튼** 추가:
  - `qf-server-btn` + Icon `message` (또는 `inbox`)
  - aria-label "DM"
  - 활성 (active workspace 가 DM 일 때) highlight
  - 클릭 → `/dm` 이동
- 027 에서 추가했던 sidebar/server-rail "DMs" 버튼 **제거** (Home 으로 통합)
- Server rail 순서 (최종): **DM** → divider → workspace 1, 2, ... → divider → `+` 생성 → `🔍` 찾기

### D. 데스크톱 DM workspace 화면

- `/dm` route — workspace 패턴 layout 재사용:
  - 좌측 channel-list-style column:
    - 상단 row: **"친구" 메뉴** (`qf-channel` 변형 또는 `qf-row`, Icon `users`)
    - 하단: 친구 목록 (ACCEPTED 만, status 정렬: online 먼저 → DnD → offline)
    - **"활동" row 는 없음** (Activity 는 별도 전체 화면)
  - 우측 메시지 영역: URL 따라 분기
    - `/dm` (default) → 친구 목록 강조 + 안내 화면 ("친구를 선택하세요")
    - `/dm/friends` → 친구 관리 inline embed (032 `/friends` page 패턴 재사용)
    - `/dm/:friendId` → 그 친구와의 DM 채팅 (기존 MessageList + Composer)
- 친구 추가 진입점: 좌측 column 상단 또는 친구 메뉴 옆 "+" 버튼 → 032 의 친구 추가 modal

### E. 모바일 Home screen

- Tabbar **Home 탭** 진입 시 `MobileHome.tsx`:
  - `qf-m-screen` 안 grid layout 두 영역:
    - **왼쪽 narrow column** (~76px): DM 포함 workspace list (mini server rail style)
      - DM 아이콘 (최상단)
      - workspace 아이콘들
      - `+` 생성, `🔍` 찾기 (데스크톱과 동일 순서)
    - **오른쪽 wider column**: 활성 항목 컨텍스트
      - DM 활성 → 친구 목록 (qf-m-row per friend + 친구 메뉴 row 위)
      - workspace 활성 → 채널 목록 (qf-m-row per channel + 카테고리 헤더)
- 왼쪽 column 의 활성 항목 highlight (qf-server-btn--active 또는 qf-m 변형)
- DS 활용 강화: `qf-m-rail` (mini server rail) 이 mobile.css 에 있으면 사용; 없으면 기존 `qf-serverlist` 의 mobile-friendly 변형

### F. 모바일 Overlay (채팅 덮기)

- 채널 또는 친구 row 선택 시:
  - 새 `qf-m-screen` overlay 가 화면 우측에서 슬라이드 in
  - CSS: `transform: translateX(100%)` → `translateX(0)`, `transition: transform var(--dur-fast) var(--ease-out)`
  - underneath Home 은 unmount X — render 유지 (overlay z-index 위)
- Overlay 좌측 상단 `qf-m-topbar__back` (`←` icon):
  - 클릭 또는 browser back → `transform: translateX(100%)` 로 slide out
  - 애니메이션 끝나면 overlay unmount + URL 갱신
- URL 매핑:
  - `/dm` ↔ `/dm/:friendId` (overlay 진입/해제)
  - `/w/:slug` ↔ `/w/:slug/c/:ch` (overlay)
- browser back 처리: `history.pushState` 로 overlay open 시 entry 추가, back 누르면 자연 close

### G. 모바일 Tabbar 재구성 (3탭)

- 현재: Home / DMs / Activity / You (4탭, 027 + 026 + 016)
- 변경: **Home / Activity / Settings** (3탭)
  - **DMs 탭 제거**: Home 의 DM workspace 로 통합 → tabbar entry 자체 제거
  - **You 탭 → Settings**: 016 You 탭 label / icon / route 모두 Settings 로 명확화. data-testid `mobile-tab-you` → `mobile-tab-settings` (E2E 영향)
  - Activity / Home 은 그대로
- Tabbar `qf-m-tab` 3개 정렬 (균등 spacing)
- E2E 회귀: 016/026 의 tabbar 관련 spec 갱신

### H. 데스크톱 BottomBar 프로필 dropdown 확장

- 현재 BottomBar 좌측 하단 프로필 영역 (016/019):
  - 프로필 아바타 + 이름 + presence dot
  - 클릭 시 dropdown menu (019 의 DnD 토글 + Settings 진입)
- 변경: dropdown 에 **"Activity" 메뉴 항목 추가**:
  - Settings 와 동일 패턴 (icon + label + nav)
  - 위치: Settings 위 또는 옆 (implementer 판단; visual hierarchy)
  - 클릭 → `/activity` 이동 (전체 화면 전환)
- DS: `qf-menu` + `qf-menu__item` 재사용 (019 dropdown 와 동일 primitive)

### I. Activity standalone 검증

- 026 데스크톱 Activity 가 이미 `/activity` standalone 페이지 (workspace shell 의 main 영역 차지) 인지 audit
- 만약 inline embed 형태였다면 standalone 으로 reshape:
  - server rail 은 보임 (다른 workspace 이동 가능)
  - 하지만 channel-list column 자체가 사라지고 `/activity` 화면이 main 영역 전체
- Settings 와 동일 layout 패턴 (019 가 standard)
- E2E `activity-fullscreen-page.e2e.ts` (Activity 페이지가 channel-list 표시 안 함 + main 영역 전체)

### J. E2E specs

신규 + 변경:

- **`home-base-state-desktop.e2e.ts`** (PC 로그인 후 default Home, server rail 최상단 "DM" 버튼 위치 + DOM 순서)
- **`dm-workspace-flow-desktop.e2e.ts`** (DM 클릭 → 친구 목록 + 친구 클릭 → DM 활성 + 메시지 전송)
- **`home-mobile-base.mobile.e2e.ts`** (모바일 Home tab → 왼쪽 workspace list + 오른쪽 channel/friend list)
- **`home-mobile-overlay.mobile.e2e.ts`** (친구 또는 채널 선택 → overlay slide-in → ← back → close 후 Home 복귀, history pushState 검증)
- **`mobile-tabbar-3-tabs.mobile.e2e.ts`** (3탭 확인 + DMs 탭 부재 + You → Settings 명칭)
- **`desktop-profile-dropdown-activity.e2e.ts`** (BottomBar 프로필 클릭 → dropdown → Activity 메뉴 → `/activity` 이동)
- **`activity-fullscreen-page.e2e.ts`** (Activity 가 main 영역 전체, channel list 표시 안 함)
- **`dm-friend-only.int.spec.ts`** (친구 아닌 사용자와 DM 거부)
- **`dm-blocked-user.int.spec.ts`** (양방향 어느 쪽이라도 BLOCKED 시 DM 거부)
- **`global-dm-channel.int.spec.ts`** (workspaceId=null DM 정상 작동, type=DIRECT 외 다른 type 은 workspaceId 필수)

기존 회귀:

- 027 / 026 / 016 의 mobile tabbar 관련 specs → 3탭으로 갱신
- 027 의 server rail DMs 버튼 spec → 제거 (DM 으로 통합됐으니 다른 assertion)

### K. develop → main auto-promote + Pane 1 auto-forward 11th

표준 flow.

## Scope (OUT)

- 그룹 DM (3+인) — 다음 task
- DM voice/video call
- 027 의 workspace-scoped DM API 완전 삭제 (deprecated 마킹만; 실제 제거는 다음 sweep)
- 027 의 friend-only invariant migration (기존 workspace-scoped DM row 가 친구 아닌 사이에 만들어졌을 수 있음 — 데이터 정합성은 사용자 트래픽 후 cleanup)
- Voice channel (task-028)
- Loki / PITR / mecab-ko / Custom emoji
- 032 follow 4건 (DM block DENY flip / cap TOCTOU / P2002 / server rail btn)
- DS mobile.css 신규 클래스 추가 (DS source of truth)

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- Prisma migration reversible:
  - `make_channel_workspace_id_nullable.sql` (+ optional CHECK constraint)
- `pnpm --filter @qufox/api test:int` green:
  - `dm-friend-only.int.spec.ts`
  - `dm-blocked-user.int.spec.ts`
  - `global-dm-channel.int.spec.ts`
  - 기존 027 workspace-scoped DM int spec 회귀 없음
- `pnpm --filter @qufox/web test:e2e` green, 신규 7 specs (위 § J)
- 데스크톱 server rail 최상단 "DM" 버튼 + DOM 순서 검증
- 데스크톱 BottomBar dropdown 에 Activity 항목 grep 증거
- 데스크톱 `/activity` 가 main 영역 전체 (channel list 표시 안 함) 확인
- 모바일 tabbar 3탭만 (DMs 탭 부재 + You 탭 부재 + Settings 탭 존재) DOM 검증
- 모바일 Home screen split (왼쪽 + 오른쪽) 양 영역 DOM 존재
- 모바일 overlay slide-in/out 애니메이션 동작 (CSS transform 검증; 정확한 pixel 검증은 OUT)
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css` untouched
- qf-m-\* 사용 카운트 증가 (overlay primitive + mobile home split, 230+ → 250+ 예상)
- 3 artefacts: `033-*.md`, `033-*.PR.md`, `033-*.review.md`
- 1 eval: `evals/tasks/044-home-dm-restructure.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` (path `/volume2/dockers/qufox-deploy/.deploy/`) last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 11번째**
- FINAL REPORT 자동 출력, 포함 항목:
  - develop/main SHA + exitCode + /readyz + idle + wall
  - 청크별 A~K 산출물 표
  - 모바일 tabbar 3탭 DOM 캡처 또는 grep
  - 데스크톱 server rail "DM" 버튼 위치 캡처
  - 027 deprecated 호출 횟수 (있다면)
  - DM block DENY (032 deferred) 가 이번에 처리됐는지 (B-1 의 차단 검증으로 자연 처리될 수 있음)
  - Deferred TODO(task-033-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 032 merged + deployed (`8ccd42b` main) — Friendship table + ACCEPTED/BLOCKED status 활성
- 027 의 `Channel.type=DIRECT` + `DirectMessageService.createOrGet` 활성
- 026 데스크톱 `/activity` 페이지 존재 (audit 결과에 따라 standalone 화)
- 019 BottomBar dropdown + Settings 진입점
- 016 모바일 You 탭 (Settings 명칭 변경 대상)
- 005 presence + status dot
- DS `qf-m-screen`, `qf-m-tabbar`, `qf-m-rail` (있으면), `qf-m-fab`, `qf-menu` 활용 가능

## Design Decisions

### Home = base state (URL 없음)

사용자 명시 — Home 은 화면 전환 안 됐을 때 보이는 기본 상태. URL 은 `/` 또는 활성 workspace/DM 의 URL. Home 자체에는 route 부여 안 함. `/dm`, `/w/:slug` 등이 base state 의 변종.

### "DM" 버튼 명칭 (Home 아님)

사용자 명시 변경. server rail 최상단 버튼 의 visible label/aria-label = "DM". DM workspace 는 다른 workspace 와 동등 위상.

### Channel.workspaceId nullable + DIRECT만

Global DM 의 가장 얇은 모델. 신규 테이블 X, 기존 channel system 재사용 (010 unread / 011 mention / 013 reaction / 014 thread / 015 search / 020 OutboxHealthIndicator 모두 자동 적용).

### 027 deprecated, 즉시 삭제 안 함

Backward compat. 호출 site 가 남아있을 수 있고 사용자 데이터에 workspace-scoped DM channel row 가 있을 수도. 다음 cleanup task 에서 metric 보고 안전 제거.

### 친구 기반 DM only

032 의 Friendship ACCEPTED 가 DM 의 prerequisite. 워크스페이스 멤버 검색 기반 (027) 은 deprecated. 차단된 사용자 (BLOCKED) 도 DM 거부 → 032 의 deferred "DM block DENY flip" 자연 해결.

### 모바일 채팅 = overlay (push X)

사용자 명시. push navigation 은 stack 이라 base state 가 unmount → 다시 mount 시 cost. overlay 는 underneath Home 유지 → 빠른 복귀, scroll 위치 보존, WS connection 재구성 불필요.

### 모바일 tabbar 3탭

DMs 는 Home 안에서 처리됨 → 별도 탭 불필요. You 는 사실상 Settings 진입점이었으므로 명칭 정확화. 4탭 → 3탭 으로 단순화 + 시각 weight 균형.

### Activity = 전체 화면 별도 페이지

데스크톱 + 모바일 동일. workspace 컨텍스트와 분리 (Activity 는 cross-workspace). dropdown / tabbar 진입.

### Settings 도 동일 패턴

019 이미 standalone. 변경 없음.

## Non-goals

- 그룹 DM
- Voice/video DM
- 027 workspace-scoped DM 완전 삭제
- DS mobile.css 새 클래스 추가
- Friend recommendation / activity feed
- DM archive / 검색 / FTS 강화

## Risks

- **Channel.workspaceId nullable 변경이 기존 쿼리에 영향**: 010 unread, 011 mention, 014 thread, 015 search 등 모두 channel.workspaceId 가정. nullable 변경 시 some queries 가 NULL 처리 안 하면 crash. 각 service 의 query audit + null 처리 추가 필수.
- **027 deprecated header 가 기존 client cache 깸**: 응답 body 동일이면 무영향. header 추가만은 무해. monitor.
- **친구 기반 DM 강제 시 기존 workspace-scoped DM 채널의 사용자 차단**: 027 에서 만든 DM channel 들은 친구 관계 없이 만들어졌을 수 있음. UI 진입은 새 `/me/dms` (friend 기반) 만 보여주므로 자연 숨김; 기존 채널 row 는 db 에 있지만 접근 안 됨. 다음 cleanup 에서 처리.
- **모바일 overlay 의 history.pushState 와 browser back**: tab switch + browser back 의 상호작용. iOS Safari edge swipe 가 시스템 예약 area 와 충돌 가능. 024 에서 다뤘던 swipe-vs-edge 패턴 재사용.
- **Activity 전체 화면 reshape (I)**: 026 데스크톱 Activity 가 inline embed 였다면 reshape 가 작은 작업이 아닐 수도. UNDERSTAND 에서 audit + 시간 측정. 큰 reshape 면 separate sub-chunk.
- **모바일 tabbar 3탭 변경 시 회귀**: 027/026/016 의 tabbar E2E spec 일제 갱신 필요. data-testid 변경에 의한 cascading 영향.
- **데스크톱 dropdown 에 Activity 추가 시 visual hierarchy**: Settings, Activity, DnD radio, Sign out 등 누적되면 overflow. 항목 수 4 이상 시 그룹 separator 사용.
- **로그인 후 default redirect**: 사용자가 마지막에 본 화면 (workspace / DM / Activity) 으로 갈지 항상 첫 workspace 로 갈지. 기본은 첫 workspace; 마지막 본 화면 기억은 `localStorage.lastView` 같은 방식 — implementer 판단.
- **027 Mobile DMs 탭 제거 회귀**: 027 의 mobile-dm-tab E2E + 026 의 mobile-tabbar E2E + 016 의 mobile-tabbar E2E — 모두 갱신.

## Progress Log

_Implementer 채움_

- [ ] UNDERSTAND (026 데스크톱 /activity 가 standalone 인지 inline 인지 audit, 027 mobile DMs 탭 관련 spec 위치, 016 You 탭 spec, 010/011/014/015 의 channel.workspaceId 쿼리 site, qf-menu primitive 시그니처, qf-m-rail 존재 여부)
- [ ] PLAN approved
- [ ] SCAFFOLD (Channel.workspaceId migration red, /dm route stub, MobileHome split layout skeleton, mobile overlay primitive stub)
- [ ] IMPLEMENT (A → B → C → D → E → F → G → H → I → J)
- [ ] VERIFY (`pnpm verify` + GHA int + e2e green)
- [ ] OBSERVE (server rail 최상단 "DM" DOM 캡처, 모바일 tabbar 3탭 캡처, overlay 애니메이션 영상/스크린샷, /activity 전체 화면 캡처)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook → FINAL REPORT auto-printed + **pane 1 auto-forwarded 11th**)
