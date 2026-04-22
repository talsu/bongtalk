# Task 027 — Direct Messages (1:1) + Mobile DMs Tab Activation → main deploy

## Context

`MobileTabBar`의 마지막 `disabled` 탭이 **DMs**입니다 (024에서
tabbar 4탭 중 DMs/Activity를 disabled로 남김; 026에서 Activity
해제 완료, DMs만 남음). 채팅 플랫폼에서 1:1 메시지가 없는 건
베타 사용자에게 가장 눈에 띄는 결여.

005의 `Channel.type` enum에 `DIRECT` 값을 (없으면) 추가하고
012의 `ChannelPermissionOverride` 인프라를 재사용해서 DM을
**채널의 특수 형태로 구현**합니다. 별도 테이블 없음. UI는
`mobile-mockups.jsx`의 `ScreenDMs()` 를 pixel 기준선으로.

## Scope (IN) — 6 chunks

### A. DB + API

- **Prisma**: `Channel.type` enum이 이미 `DIRECT` 를 포함하는지
  UNDERSTAND에서 확인. 없으면 reversible migration 으로 추가
  (`ALTER TYPE channel_type ADD VALUE 'DIRECT'`).
- `DirectMessageService` 신규 (`apps/api/src/channels/direct-messages/`):
  - `createOrGet(workspaceId, me, otherUserId)` — 기존 DM 있으면
    기존 `channelId` 반환, 없으면 새 Channel (`type=DIRECT`,
    `isPrivate=true`, `name=` internal id, `topic=null`) +
    두 `ChannelPermissionOverride` row (USER/ALLOW
    READ+WRITE_MESSAGE+UPLOAD_ATTACHMENT) 생성 in a transaction
  - 양방향 중복 방지: `(workspaceId, minUserId, maxUserId)`
    컴퍼짓 unique 또는 query-level guard
- **API**:
  - `POST /me/workspaces/:wsId/dms` body `{ userId }` → `{ channelId, channel }`
    - validation: `otherUserId` must be workspace member (403 `NOT_MEMBER`
      otherwise), cannot self (`400 INVALID_TARGET`)
  - `GET /me/workspaces/:wsId/dms` → DM 채널 리스트 (상대 user
    info + 마지막 메시지 + unread count + last activity time)
    - cursor pagination, default sort = last activity desc
  - `GET /me/workspaces/:wsId/dms/by-user/:userId` — 1회 조회용 (channelId만 반환)
- **Rate limit**: `POST` 20 rpm/user (DM spam 방지)

### B. 권한 모델 (ChannelAccessGuard 특수 처리)

- `Channel.type=DIRECT` 인 채널은:
  - `isPrivate` 강제 true (migration + schema invariant)
  - OWNER/ADMIN workspace role **조차 자동 access 불가** — 참여자 2명만
  - `ChannelAccessGuard` 에서 `channel.type === 'DIRECT'` 분기 →
    `ChannelPermissionOverride` 에 해당 user의 USER-level ALLOW 존재
    여부만 확인 (workspace role bypass 제거)
- `channels.service.list` / `channel-position` 등 기존 쿼리는
  기본적으로 `type != 'DIRECT'` 필터 적용 (채널 리스트에 DM이
  섞이지 않게). 별도 `DmService.list` 만 DIRECT 조회
- Audit test: DM 채널 생성 후 OWNER/ADMIN role 사용자가
  `GET /channels/:id/messages` 호출 → 403 `CHANNEL_NOT_VISIBLE`

### C. 데스크톱 DM UI

- 신규 route:
  - `/w/:slug/dm` — DM list 페이지
  - `/w/:slug/dm/:userId` — 구체 DM chat
- **Server rail** 하단에 `qf-server-btn` 신규 ("DMs" entry) —
  Icon `inbox` or `message`. 클릭 시 `/w/:slug/dm` 이동.
- DM list 페이지 (`apps/web/src/features/dms/DmListPage.tsx`):
  - 상단: `qf-input` 검색 input + "New DM" 버튼
  - New DM modal: 워크스페이스 멤버 검색 combobox → 선택 →
    createOrGet → chat으로 navigate
  - Body: 최근 DM list (avatar + name + role badge if OWNER/MOD +
    last message preview + relative time + unread dot/count)
  - 클릭 → `/w/:slug/dm/:userId`
  - 빈 상태: `qf-empty`
- DM chat (`apps/web/src/features/dms/DmChatPage.tsx`):
  - Topbar: 상대방 avatar (with status dot) + name + close button
  - 기존 `MessageList` + `MessageComposer` 재사용 (same channel
    primitives)
  - Thread 기능은 DM에서 OUT (1:1에 thread는 과잉) — `parentMessageId`
    UI 없음

### D. 모바일 DM UI (ScreenDMs 목업 parity)

- `MobileTabBar.tsx` — DMs 탭 `aria-disabled` 제거, `/dms`
  navigate
- 신규 route (모바일 viewport):
  - `/dms` — 현재 활성 workspace의 DM list
  - `/dms/:userId` — DM chat
- `MobileDmList.tsx`:
  - `qf-m-screen` + `qf-m-topbar` (title="Direct messages",
    subtitle=워크스페이스 이름, `qf-m-topbar__action` 검색+new)
  - `qf-m-search` / `qf-m-search__input` (클라이언트 필터)
  - `qf-m-section` (Pinned / All — 베타는 Pinned 2개 고정 로직
    없으므로 All만 우선, Pinned 섹션은 empty면 skip)
  - `qf-m-row` per DM (ScreenDMs mockup과 동일 구조):
    avatar + role badge + primary + secondary + aside(time+
    unread count)
  - `qf-m-fab` "New DM" → 검색 modal (mobile sheet)
  - `qf-m-tabbar` — DMs 탭 active
- `MobileDmChat.tsx`:
  - 기존 `MobileMessages` 재사용 + topbar 상대방 이름
  - `/dms/:userId` route
- `/activity` 와 동일 pattern으로 mobile viewport일 때 자동
  mobile 화면

### E. 019 Notification preferences 통합 + 026 Activity 확장

- **019**: `UserNotificationPreference.eventType=DIRECT` 값
  이미 enum에 있음. Dispatcher에 **`dm.received` 신규 이벤트**
  추가 (기존 `message.created` 이벤트를 DM 채널에서 발생 시
  fan-out하는 분기), preference lookup:
  1. `(userId, workspaceId, 'DIRECT')`
  2. `(userId, null, 'DIRECT')`
  3. hardcoded default `BOTH` (toast + browser notification)
- 기존 `mention.received` / `message.thread.replied` / `message.reaction.added`
  dispatcher에 DM 채널 필터 추가 — DM 채널에서는 mention/reply/
  reaction이 DIRECT로 통합 되도록, 아니면 그대로 각 eventType
  유지 (결정: **DIRECT 전용**. DM에서 @mention은 tautology)
- **026**: Activity inbox에 `type=direct` 추가 — DM 수신도
  Activity 목록에 들어감 (워크스페이스 전체 알림 이력에 DM도
  포함)
- 019 설정 페이지에 `DIRECT` row 표시 (현재 enum이지만 UI에
  노출 안 돼있을 수 있음) — UI audit 후 추가

### F. E2E + polish

- `apps/web/e2e/dms/` 신규:
  - `dm-create-flow.e2e.ts` — A가 B를 검색 → DM 생성 →
    메시지 전송 → B 브라우저에 실시간 수신
  - `dm-reopen-existing.e2e.ts` — 같은 사용자와 두 번째 DM 시도
    → 기존 channelId 반환 (idempotent)
  - `dm-permission-isolation.e2e.ts` — C(제3자, workspace OWNER
    포함) 가 DM channelId로 `GET /channels/:id/messages` → 403
  - `dm-notification.e2e.ts` — 019 preferences `DIRECT=OFF`
    → 토스트 없음. `DIRECT=BOTH` → toast + Activity inbox에 등장
  - `dm-mobile-tab.mobile.e2e.ts` — 모바일 tabbar DMs 탭 enabled
    → /dms 이동 + ScreenDMs 목업 pixel parity
  - `dm-mobile-chat.mobile.e2e.ts` — 모바일 DM chat → 메시지
    전송 + 수신
- `mobile-vr-parity.mobile.e2e.ts` baseline 재시딩 (ScreenDMs
  대응)

## Scope (OUT) — 다음 task

- 그룹 DM (3인 이상)
- 친구 추가/수락 플로우
- Cross-workspace DM
- DM 내 voice/video call
- DM archive / 영구 삭제
- DMs 서버측 검색 (015 FTS가 channel-scoped이라 DM도 자동 포함되지만
  UI 노출은 추후)
- Voice channel (task-028)
- 026 follow (nested-reply / markAllRead pagination / VR reseed) —
  다음 hygiene sweep
- Loki / mecab-ko / PITR

## Acceptance Criteria (mechanical)

- `pnpm verify` green.
- Prisma migration reversible (if `DIRECT` enum value needs adding).
- `pnpm --filter @qufox/api test:int` green, 신규:
  - `dm-service.int.spec.ts` (create-or-get idempotent + ACL auto-setup
    - self-DM rejected + non-member rejected)
  - `dm-access-guard.int.spec.ts` (제3자 차단, OWNER도 차단 테스트)
  - `dm-notification-preferences.int.spec.ts` (DIRECT enum 활성)
- `pnpm --filter @qufox/web test:e2e` green, 신규 6 specs (위 § F)
- 모바일 tabbar DMs 탭의 `aria-disabled` 제거 확인 (`grep -rn
'aria-disabled' apps/web/src/shell/mobile/MobileTabBar.tsx`
  결과에 DMs entry 미포함)
- `grep -rn '\.type.*DIRECT\|type: .DIRECT' apps/api/src/channels/`
  ≥ 3 lines (guard + service + list filter)
- Channel 기존 기능 회귀 없음 — 018~022 폴리시 harness 전부 green
- DS `mobile.css` / `tokens.css` / `components.css` untouched
- `qf-m-*` grep count 증가 확인 (136 → 150+ 예상, ScreenDMs
  구조 반영)
- 3 artefacts: `027-*.md`, `027-*.PR.md`, `027-*.review.md`
- 1 eval: `evals/tasks/039-direct-messages.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` (path `/volume2/dockers/qufox-deploy/.deploy/`)
  last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward** (5번째 적용)
- FINAL REPORT 자동 출력, 포함 항목:
  - develop/main SHA + exitCode + /readyz + idle-window + wall
  - 청크별 A~F 산출물
  - `Channel.type=DIRECT` 미가입 사용자 차단 증거 (int spec
    pass + manual curl)
  - qf-m-\* count before/after
  - 모바일 tabbar disabled 탭 0개 confirmed
  - Deferred TODO(task-027-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 026 merged + deployed (`1d84747` main)
- 005 `Channel.type` enum (TEXT / VOICE 등) 존재
- 012 `ChannelPermissionOverride` 테이블 + `PermissionMatrix.effective`
- 019 `UserNotificationPreference` + `DIRECT` eventType enum
- 026 Activity inbox + dispatcher
- 024 모바일 shell (DMs 탭 disabled 상태)
- `feedback_auto_promote_to_main` + `feedback_pane0_auto_forward_report` 메모리

## Design Decisions

### Per-workspace DM, cross-workspace 제외

이 베타는 workspace 중심 모델. 친구 목록 / cross-workspace DM은
별도 feature 큰 작업. 워크스페이스 멤버끼리만 DM → 검색 범위
축소 + 권한 단순.

### `Channel.type=DIRECT` 재사용, 신규 테이블 없음

005의 Channel + 012의 ChannelPermissionOverride + 010의 unread

- 011/013/014의 realtime이 모두 Channel 기반. 신규 테이블 만들면
  이 5개 시스템을 중복 구현해야. type enum 하나로 해결.

### 1:1 only (그룹 DM 제외)

그룹 DM은 멤버 관리 UI + 이름 설정 + 멤버 수 cap 등 별도 UX.
베타에서 1:1로 가장 큰 체감 해결 후 그룹 DM은 별도 task.

### ACL: OWNER/ADMIN도 DM 읽기 불가

워크스페이스 role bypass는 TEXT/VOICE 채널에서만. DM은
"private private" — 두 당사자만 절대 볼 수 있음. PermissionMatrix
변경 아님: Guard 레벨에서 `type=DIRECT` 분기 체크.

### 검색 기반 시작, 친구 시스템 OUT

친구 시스템은 add/accept/block 등 상태기계 + UI 큰 작업.
베타는 "검색 → 생성" 플로우가 가장 단순. 스팸 대응은 rate
limit 20/min + workspace 멤버 제한으로 충분.

### 데스크톱 route는 `/w/:slug/dm/*`, 모바일은 `/dms/*`

데스크톱은 server rail이 워크스페이스 컨텍스트 표현 → URL에도
명시. 모바일 tabbar는 이미 선택된 워크스페이스 기준 → URL 단순
`/dms` 가 UX 맞음. `useBreakpoint`에 따라 redirect.

### 019의 DIRECT eventType 활성화

019에서 enum에 `DIRECT` 추가됐지만 dispatcher 경로가 mention/
reply/reaction만 있었음. 027에서 실제 적용. DM 메시지 1건 =
DIRECT 알림 1건 (멘션/reaction 중복 계산 X).

### 026 Activity에 DM 통합

DM 수신 = Activity inbox의 `type=direct` row. 026에서 예약한
세 source(mention/reply/reaction)에 DM 추가. UI 및 쿼리 확장.

## Non-goals

- 그룹 DM
- 친구 / 차단 / 숨기기 시스템
- Cross-workspace DM
- DM 전용 검색 UI (기존 FTS가 자동 포함)
- Voice / video call
- DM 메시지 암호화 (베타 미적용)

## Risks

- **`Channel.type` enum 값 추가 migration** — Postgres enum에
  값 추가는 reversible하되 제거는 어려움. down script는
  "새 enum type 생성 + column migration + old type drop" 패턴
  필요 (복잡). 대안: `DIRECT` 가 이미 있으면 migration 자체
  스킵. UNDERSTAND에서 확인 필수.
- **ChannelAccessGuard의 기존 bypass 로직이 OWNER/ADMIN에 넓게
  허용됨** — DIRECT 분기 추가가 기존 path에 영향 없는지 regression
  test 필요 (TEXT/VOICE 채널의 OWNER 접근 정상).
- **DM channel의 workspace member leave race** — A가 workspace
  탈퇴 → A-B DM은 어떻게? mitigation: `ChannelPermissionOverride`
  는 workspace 멤버십과 독립적이라 DM은 계속 존재하되 A 쪽 view
  에서 워크스페이스 자체가 안 보임. 베타 acceptable. 영구 삭제
  로직은 별도 purge worker (task-034).
- **DM list query N+1** — 각 DM 마다 상대 user fetch + 마지막
  메시지 fetch. 한 번의 쿼리에 JOIN 또는 IN-batch로 합쳐야.
  EXPLAIN 검증.
- **모바일 tabbar 4개 탭 전부 enabled 되면 visual weight 증가** —
  024/026 mockup 기준 괜찮지만 실기기 확인 필요.
- **019의 DIRECT preference row가 없는 기존 사용자는 fallback**
  — 하드코딩 default BOTH. `UserNotificationPreference`에 DIRECT
  row 없으면 global NULL row → default 순서.
- **Activity 026 UNION query에 source 추가** — 3 → 4 소스.
  쿼리 plan 변경 가능. EXPLAIN 재측정.
- **DM ACL leak 위험** — OWNER가 `unread-summary`를 호출하면
  019 fix에서 ACL 통과 여부에 따라 private 채널 unread 노출 안
  되지만 **DM은 private 이상의 "only-me-and-them"**. 재확인 필수.

## Progress Log

_Implementer 채움 — A → B → C → D → E → F 순._

- [ ] UNDERSTAND (Channel.type enum 상태, ChannelAccessGuard
      현재 path, ChannelPermissionOverride schema, 019 DIRECT
      enum + dispatcher, 026 Activity source enum 확장 가능
      여부, 모바일 `ScreenDMs()` 구조 재확인)
- [ ] PLAN approved
- [ ] SCAFFOLD (DirectMessageService stub, DmListPage/DmChatPage
      skeleton, 모바일 경로)
- [ ] IMPLEMENT (A → B → C → D → E → F)
- [ ] VERIFY (`pnpm verify` + GHA int + e2e green + 모바일
      tabbar DMs enabled 수동 확인)
- [ ] OBSERVE (OWNER가 DM 읽기 차단되는 curl test 결과 기록,
      DM list query EXPLAIN, qf-m-\* count 증가 기록)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT printed + **pane 1 auto-forwarded**)
