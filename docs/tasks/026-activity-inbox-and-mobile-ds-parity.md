# Task 026 — Activity Inbox + Mobile DS Mockup Parity + Icon Pack Swap → main deploy

## Context

세 가지 gap을 한 task로 묶습니다:

1. **Activity inbox 없음** — 011 mention / 014 reply / 013 reaction
   outbox가 이벤트를 발행하고 있지만 한 곳에서 확인할 페이지가
   없습니다. 모바일 tabbar의 Activity는 024에서 `disabled`로
   남김.
2. **모바일 DS mockup 시각 gap** — `/design-system/index.html`
   의 `Mobile > iOS, Android screens` 섹션(`mobile-mockups.jsx`)
   에서 정의된 컴포넌트 다수가 실제 앱에 **적용 안 됨**:
   `qf-m-search` / `qf-m-search__input`, `qf-m-section` /
   `qf-m-section__action`, `qf-m-row--unread` / `qf-m-row__primary`
   / `qf-m-row__secondary` / `qf-m-row__aside` / `qf-m-row__time`,
   `qf-m-tab` 내부 구조(`__icon` / `__label` / `__badge` / `__dot`),
   `qf-m-topbar__titleBlock` / `__subtitle` / `__actions` /
   `__action`, `qf-m-fab` 등. 베타 사용자가 실 기기로 열면
   DS 라이브 문서와 다른 거친 형상이 보입니다.
3. **이모지 아이콘 하드코딩** — 🔍 / ✏️ / 🏠 / 💬 / 🔔 / 👤 /
   ☰ 등 UI 역할의 이모지가 `MobileTabBar.tsx` / `MobileShell.tsx`
   / `MobileMessageSheet.tsx` 등에 하드코딩. 018에서 도입한
   \*\*102-icon pack (`apps/web/public/design-system/icons.svg`
   - `Icon` primitive)\*\* 을 사용해야 DS 일관성 확보.

ScreenActivity 목업이 `mobile-mockups.jsx`의
`ScreenActivity()` 함수로 이미 그려져 있어 Activity 페이지
구현의 pixel 기준선 역할을 합니다.

## Scope (IN) — 9 chunks

### A. Activity DB + API

- Prisma `UserActivityReadState` 테이블 (reversible migration):
  ```
  id           uuid pk
  userId       uuid fk -> User.id ON DELETE CASCADE
  activityKey  text   -- 'mention:<msgId>' | 'reply:<msgId>' | 'reaction:<reactionId>'
  readAt       timestamptz
  updatedAt    timestamptz
  unique (userId, activityKey)
  ```
  Indexes: `(userId, readAt DESC)`.
- API:
  - `GET /me/activity?filter=all|mentions|replies|reactions&cursor&limit=50`
  - `POST /me/activity/:activityKey/read`
  - `POST /me/activity/read-all?filter=...`
  - `GET /me/activity/unread-counts` → `{ total, mentions, replies, reactions }`
- Rate limit: read 엔드포인트 60 rpm/user.

### B. Activity query (UNION over messages + reactions)

- 세 소스를 UNION ALL + `ChannelAccessService.resolveEffective`
  필터링:
  1. `messages` WHERE `mentions @> [{userId: :me}]` → 'mention'
  2. `messages` WHERE exists reply to a root authored by me →
     'reply'
  3. `message_reactions` WHERE `message.authorId = :me` AND
     `user_id != :me` → 'reaction'
- 각 row의 `created_at` + synthesized `activityKey` 조합으로
  cursor pagination (`(created_at DESC, activityKey)`).
- `LEFT JOIN UserActivityReadState` 로 read 상태 + `readAt`
  포함.
- EXPLAIN 필수. 세 소스 각각에 partial index 필요한지 검토
  (특히 jsonb mentions GIN).
- 신규 int spec `activity-query.int.spec.ts` — 각 소스별
  rows + filter + ACL (private 채널 제외) + cursor 페이지네이션
  - read/unread 반영.

### C. 데스크톱 Activity 페이지

- 신규 route `/activity` (global, workspace-agnostic).
- Layout: 기존 shell의 오른쪽 panel 대신 전체 `<main>`에
  Activity 페이지. `qf-settings` 비슷한 layout 재사용.
- 상단 탭바 (All / @Mentions / Replies / Reactions) — `qf-tabs`
  기존 primitive 활용
- 리스트: per-row에 avatar · author · action text (e.g.
  "@you in #general") · message preview 2줄 · workspace/channel
  컨텍스트 · relative time · unread dot
- 클릭 → `/w/:slug/c/:ch?msg=<id>` 이동 + read 처리
  (optimistic + server-confirm)
- 상단 우측 "Mark all read" 버튼 (현재 필터 범위 내)
- 빈 상태: `qf-empty` 재사용 + "모든 알림을 읽었습니다" 메시지
- neural state: WS push로 실시간 top 추가 (스크롤 위치 유지
  - unread counter 변화)

### D. 모바일 Activity 화면 (ScreenActivity 목업 parity)

- `mobile-mockups.jsx`의 `ScreenActivity()` 함수와 pixel-parity
  로 구현
- 구조:
  - `qf-m-screen`
  - topbar: `qf-m-topbar` (back 아이콘 + titleBlock (title =
    "Activity" + subtitle = 필터 상태) + actions)
  - body: `qf-m-segment` 4탭 (All / Mentions / Replies /
    Reactions) + 아이템 리스트 (`qf-m-row` + `qf-m-row__primary`
    / `__secondary` / `__aside` / `__time` / `qf-m-row--unread`)
  - `qf-m-tabbar` 하단 — 다른 탭 전환
- `qf-m-fab`은 Activity 페이지에서 **"Mark all read"** 버튼으로
  활용 (현재 필터 영역 일괄 read)
- 검색은 `qf-m-search` + `qf-m-search__input` 사용 (Activity
  내 검색 — 본 task에서는 client-side filter만; 서버 검색은
  out)
- `qf-m-section` 헤더로 "오늘" / "지난 7일" / "이전" 그룹핑
- 라우트: `/activity` 진입 시 모바일 viewport면 자동으로 이
  화면

### E. Realtime 업데이트

- 011 dispatcher의 `mention.received` + 014 dispatcher의
  `message.thread.replied` + 013의 `message.reaction.added`
  분기 확장 — Activity 데이터 받는 사용자면:
  - React Query 캐시 invalidate: `/me/activity?filter=*`,
    `/me/activity/unread-counts`
  - unread counter +1 (`useActivityUnread()` 훅)
- 019 notification preferences가 `channel=OFF`여도 Activity
  기록은 **항상 유지** (toast/browser 알림 채널만 끄는 것이지
  이력을 끄는 것은 아님)

### F. Unread 뱃지

- 데스크톱: 우측 topbar 영역(기존 프로필/설정 근처) 또는
  BottomBar에 Bell 아이콘 + `qf-badge--count`
- 모바일: `qf-m-tabbar`의 Activity 탭에 `qf-m-tab__badge` or
  `qf-m-tab__dot` (unread > 0이면 dot, > 9면 숫자 badge)
- `useActivityUnread()` 훅 신규

### G. 모바일 DS mockup 시각 parity 적용

**`mobile-mockups.jsx`의 5개 screen에서 사용하는 모든
`qf-m-*` 서브클래스를 실제 앱에 적용**. 앱 코드의 기존
모바일 컴포넌트를 mockup 구조에 맞춰 정렬:

| 영역                                                                            | 적용 대상                                                      | mockup 참조                                              |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `qf-m-topbar` 내부 구조                                                         | `MobileShell.tsx` / `MobileMessages.tsx` / `MobileMembers.tsx` | `ScreenDMs/Channel/Activity/Voice` 모두 topbar 동일 구조 |
| `qf-m-topbar__titleBlock` + `__title` + `__subtitle` + `__actions` + `__action` | 위와 동일                                                      | 서브타이틀은 현재 채널/설명, actions는 검색/멤버 버튼    |
| `qf-m-search` + `qf-m-search__input`                                            | 채널 리스트 + Activity + DMs                                   | 사이드 drawer + 주요 화면들                              |
| `qf-m-section` + `qf-m-section__action`                                         | `MobileChannelList.tsx` + Activity 화면                        | 카테고리 헤더 + "See all" 액션                           |
| `qf-m-row__primary` / `__secondary` / `__aside` / `__time`                      | `MobileChannelList.tsx` + `MobileMembers.tsx` + Activity       | 모든 row 구조 통일                                       |
| `qf-m-row--unread`                                                              | Activity + 채널 리스트 (unread 채널)                           | mockup ScreenDMs 참조                                    |
| `qf-m-tab` + `__icon` / `__label` / `__badge` / `__dot`                         | `MobileTabBar.tsx`                                             | 현재 단순 구조 → mockup 내부 구조로                      |
| `qf-m-fab`                                                                      | Activity의 "mark all read", 채널 리스트의 "새 채널"            | 현재 누락                                                |
| `qf-m-segment`                                                                  | Activity 내 4탭, 필요 시 다른 filter UI                        | 현재 누락                                                |
| `qf-m-empty`                                                                    | 빈 상태                                                        | 현재 default `qf-empty` 사용                             |

- **DS `mobile.css` 수정 없음** (memory 준수) — 적용만.
- 적용 후 `grep -rn 'qf-m-' apps/web/src/ | wc -l` ≥ 120
  목표 (현 78 → +40 이상).

### H. 이모지 → Icon Pack swap

`apps/web/public/design-system/icons.svg`(102 symbols) +
`Icon` primitive(018-C) 활용. 모바일 컴포넌트에서 UI 역할의
이모지 전부 → `<Icon name="..." />` 로 교체.

대상 (현재 grep된 건 + mockup에 있는 것 합쳐):

| 현재 이모지                                                              | Icon name (icons.svg에 있는)                                           | 사용 위치                                |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------- |
| 🏠 Home tab                                                              | `home`                                                                 | `MobileTabBar`                           |
| 💬 DMs tab                                                               | `message`                                                              | `MobileTabBar`                           |
| 🔔 Activity tab                                                          | `bell`                                                                 | `MobileTabBar`                           |
| 👤 You tab                                                               | `user`                                                                 | `MobileTabBar`                           |
| ☰ Hamburger                                                              | `menu` (icons.svg 내 확인 필요; 없으면 `grid-vertical` 또는 신규 추가) | `MobileShell` topbar back                |
| 👥 Members                                                               | `users`                                                                | `MobileMessages` topbar                  |
| 🔍 Search                                                                | `search`                                                               | Activity / DMs search                    |
| ✏️ Compose / edit                                                        | `edit` or `plus`                                                       | FAB, topbar actions                      |
| ← Back                                                                   | `chevron-left` or `arrow-left`                                         | 모바일 topbar back                       |
| # Channel                                                                | `hash`                                                                 | 채널 row                                 |
| 🔊 Voice channel                                                         | `volume`                                                               | 채널 row (보이스 채널이 있으면)          |
| 📢 Announcement                                                          | `megaphone`                                                            | 채널 row (있으면)                        |
| 👑 Owner badge                                                           | `crown`                                                                | 역할 badge                               |
| 🦊 / 🚀 / 👀 등 reaction quick-row emoji                                 | **유지** (이건 사용자 입력 콘텐츠이지 UI chrome 아님)                  | `MessageSheet` quick row                 |
| IME 이슈 방지를 위해 `placeholder`의 `#`도 `<Icon name="hash">`로 prefix | `hash`                                                                 | `MessageComposer` placeholder는 텍스트만 |

- 기준 규칙: **UI chrome/네비게이션 이모지는 Icon pack으로,
  메시지 콘텐츠/reaction/이모지 picker 이모지는 유지**.
- 아이콘 color / size: `qf-m-topbar__action` 등의 css가 `em`
  기준이라 Icon은 `<Icon name="search" size={24} />` 같이
  구체 pixel 대신 `em` relative 권장. size prop 없으면
  inherit.
- `Icon` primitive가 아직 없다면 (또는 mobile에서 미활용)
  `apps/web/src/design-system/primitives/Icon.tsx` 현재 구현
  audit 후 확장 필요.
- `grep -rn '[🏠💬🔔👤☰👥🔍✏️←👑]' apps/web/src/shell/mobile/
apps/web/src/shell/MobileShell.tsx` 는 Task 완료 시 **0건**.

### I. E2E + polish

- `apps/web/e2e/activity/` 신규:
  - `activity-inbox-desktop.e2e.ts` — 데스크톱 /activity 페이지
    (A 멘션 → B 리스트 표시 + unread → 클릭 이동 + read)
  - `activity-filters.e2e.ts` — 4탭 전환 + 각 필터 정확성
  - `activity-mark-all-read.e2e.ts` — 일괄 read 처리
  - `activity-realtime-update.e2e.ts` — WS push 반영 + 카운터
- `apps/web/e2e/mobile/`에 추가:
  - `mobile-activity-screen.mobile.e2e.ts` — 모바일 `/activity`
    DS parity (`qf-m-segment` 4탭 + `qf-m-row__primary` 표시
    - `qf-m-fab` mark-all-read)
  - `mobile-ds-parity-icons.mobile.e2e.ts` — 이모지 하드코딩
    0건 (grep-based + DOM text 검증 둘 다)
  - `mobile-ds-parity-tabbar.mobile.e2e.ts` — tabbar 내부
    구조(`qf-m-tab__icon` / `__label` / `__badge` / `__dot`)
    존재 + layout 정확
- `mobile-vr-parity.mobile.e2e.ts` baseline 재시딩 (025에서
  찍은 후 변경이 크니 한 번 더)

## Scope (OUT) — 다음 task

- Push notification (브라우저 outside)
- Email digest
- Activity archive / 영구 삭제
- Activity 내 서버측 검색 (기본은 client-side filter만)
- DMs 기능 구현 (tabbar의 DMs는 여전히 `disabled`)
- Voice channel (`ScreenVoice` 목업은 mockup-only)
- mobile.css 수정 (DS source of truth)

## Acceptance Criteria (mechanical)

- `pnpm verify` green.
- `pnpm --filter @qufox/api test:int` green, 신규:
  - `activity-query.int.spec.ts` (UNION + ACL + cursor)
  - `activity-read-state.int.spec.ts` (read/read-all/unread-counts)
- `pnpm --filter @qufox/web test:e2e` green, 신규 7 specs:
  - 4 desktop activity specs + 3 mobile specs (위 I 참조)
- 1 Prisma migration, reversible-first (`add_user_activity_read_state.sql`)
- `EXPLAIN` 결과 `docs/tasks/026-*.PR.md`에 첨부 (UNION 쿼리
  - mentions GIN 사용 확인)
- `grep -rn 'qf-m-' apps/web/src/ | wc -l` **≥ 120**
  (현 78 대비 +40 이상)
- `grep -rn '[🏠💬🔔👤☰👥🔍✏️←👑📢🔊#]' apps/web/src/shell/`
  (UI chrome 이모지) **0 matches**
- `apps/web/public/design-system/mobile.css` `tokens.css`
  `components.css` 모두 **untouched** (git diff 0)
- 3 artefacts: `026-*.md`, `026-*.PR.md`, `026-*.review.md`
- 1 eval: `evals/tasks/038-activity-inbox.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop 머지 → main auto-promote via webhook
- `.deploy/audit.jsonl` (path `/volume2/dockers/qufox-deploy/...`)
  last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward** (4번째 적용)
- FINAL REPORT 자동 출력, 포함 항목:
  - develop/main SHA + deploy exitCode + /readyz + idle-window
    - wall
  - 청크별 A~I 산출물
  - **`grep qf-m-* count` before/after** + **이모지 제거
    count**
  - VR baseline 재시딩 여부
  - Deferred `TODO(task-026-follow-*)`

## Prerequisite outcomes

- 025 merged + deployed (`fc2a5a1` main)
- 011 mention / 014 reply / 013 reaction dispatcher 정상 작동
- 019 notification preferences 테이블 존재
- 018 `Icon` primitive + `icons.svg` 102 symbols
- `feedback_auto_promote_to_main` + `feedback_pane0_auto_forward_report`
  적용
- DS `mobile.css` + `mobile-mockups.jsx` + `ios-frame.jsx` 현
  상태 (025에서 변동 없음)

## Design Decisions

### Activity query는 messages/reactions 직접 JOIN (신규 테이블 최소)

outbox 이벤트를 별도 `ActivityItem` 테이블에 복제하면 중복
데이터 + migration 필요. messages.mentions (jsonb) +
parentMessageId + MessageReaction이 이미 영구 데이터이므로
UNION이 가장 얇은 shape.

### `UserActivityReadState`만 신규

read 상태는 messages에 녹일 수 없음 (여러 사용자 x N
activity types). 경량 테이블 1개가 최소비용.

### `/activity` global, per-workspace 아님

Discord 방식. 사용자가 워크스페이스 1-2개 쓰는 베타에서는
통합이 오히려 동선 짧음. 향후 per-workspace 필터가 필요하면
query param으로 확장.

### Mobile DS mockup parity는 "적용"만, DS 수정 없음

`mobile.css`에 정의된 클래스들을 `apps/web/src/`에서 사용하는
것이 이번 task. mockup jsx와 동일한 마크업 조합을 재현.
DS 파일 수정은 memory 위배.

### Icon pack swap은 UI chrome만, 사용자 콘텐츠는 유지

- UI chrome 이모지 (🏠/💬/🔔/👤/☰/👥/🔍/✏️/←/👑/#/🔊/📢)
  → Icon pack
- 사용자 입력 이모지 (reaction quick row 🦊🚀❤️ 등) → 유지
- reaction picker 이모지 → 유지 (사용자가 선택하는 콘텐츠)
- 기준: "UI 제어의 아이콘인가, 콘텐츠인가"

### ScreenActivity 목업이 픽셀 기준

`mobile-mockups.jsx`의 `ScreenActivity()` 가 VR baseline
역할. mobile Activity E2E에서 pixel parity 검증.

## Non-goals

- DMs 실제 구현 (이번 task에서도 여전히 disabled)
- Voice channel (mockup만 있음)
- FAB 실제 action 전반 확장 (Activity mark-all-read만)
- Push / email / digest
- Activity archive / 영구 삭제
- server-side activity 검색

## Risks

- **UNION 쿼리 성능** — 세 소스의 row 합계가 커지면 cursor
  pagination 효율 떨어짐. partial index / materialized view는
  추후 polish에서 고려. 일단 EXPLAIN 증거 확보.
- **jsonb mentions GIN 유무** — messages.mentions jsonb에 GIN
  인덱스가 없으면 full scan. 004에서 추가됐는지 UNDERSTAND에서
  확인; 없으면 `CREATE INDEX CONCURRENTLY`로 이 task에 추가.
- **이모지 ↔ Icon swap 후 사이즈 drift** — 이모지는 font에
  의존, Icon은 SVG. line-height/padding이 미묘하게 달라질 수
  있음. 각 교체 위치에 VR assertion 또는 bounding box 체크.
- **`Icon` primitive 모바일 지원 부족** — 018은 데스크톱 기준
  도입. 모바일 `em`/relative sizing에 맞게 확장 필요할 수
  있음. UNDERSTAND에서 audit.
- **Activity unread count drift** — realtime 증분 vs 페이지
  로드 시 서버 집계가 다를 수 있음. Race 방지: 페이지 마운트
  시 서버 값으로 강제 동기화, 그 후 increment.
- **모바일 `/activity` route 도달 경로** — 024의 tabbar가
  `disabled`였음. 026에서 enabled + `/activity` 네비게이트.
  useBreakpoint가 모바일이면 자동으로 D 화면, 아니면 C 화면
  분기.
- **VR baseline 재시딩이 CI에서 drift 유도** — 026에서 시각
  변경이 크므로 기존 baseline 폐기하고 재시딩. `--update-snapshots`
  한 번 실행 후 커밋.
- **이모지 제거 grep이 false positive** — 메시지 콘텐츠 영역
  (`MessageItem` body 등)의 이모지까지 잡아내면 안 됨. grep
  스코프를 `apps/web/src/shell/mobile/` 와 모바일 chrome
  파일로 제한.

## Progress Log

_Implementer 채움 — A → B → C → D → E → F → G → H → I 순 권장.
G/H는 D 작업 중 겸해서 진행해도 OK (같은 파일 건드릴 가능성
높음)._

- [ ] UNDERSTAND (messages.mentions GIN 존재 확인, `Icon`
      primitive 현황, `mobile-mockups.jsx` 5 screens 구조
      재확인, 현재 qf-m-\* grep count baseline 기록)
- [ ] PLAN approved
- [ ] SCAFFOLD (Activity read state migration red, API 엔드포인트
      stub, Activity page skeleton, 모바일 Activity skeleton)
- [ ] IMPLEMENT (A → B → C → D → E → F → G → H → I)
- [ ] VERIFY (`pnpm verify` + GHA e2e green + VR baseline 재시딩)
- [ ] OBSERVE (UNION 쿼리 EXPLAIN 캡처, qf-m-\* count 전후
      비교, 이모지 제거 grep 결과 0)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT printed + **pane 1 auto-forwarded**)
