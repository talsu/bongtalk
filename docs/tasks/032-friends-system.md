# Task 032 — F-2 Friends System (요청 / 수락 / 차단 + 019 / 026 통합) → main deploy

## Context

`feature-backlog.md` 의 **F-2**. 027 의 1:1 DM 은 워크스페이스
멤버 검색 기반이지만, F-3 (Home = DMs + 친구 사이드바) 의
선행 조건은 친구 목록 데이터 소스. 032 는 Discord-style 친구
시스템을 깔고 019 notification + 026 Activity inbox 와 통합
합니다.

데스크톱은 standalone `/friends` page, 모바일은 동일 route 의
`qf-m-screen` 화면. server rail 진입점 추가는 F-3 에서 Home
재배치 시 함께 하므로 032 scope 에서는 OUT.

## Scope (IN) — 7 chunks

### A. DB Schema

Prisma migration (reversible):

```
Friendship {
  id            uuid pk
  requesterId   uuid fk -> User.id ON DELETE CASCADE
  addresseeId   uuid fk -> User.id ON DELETE CASCADE
  status        FriendshipStatus  -- PENDING | ACCEPTED | BLOCKED
  requestedAt   timestamptz default now()
  respondedAt   timestamptz?
  unique (requesterId, addresseeId)  -- 한 방향만 row, 양방향은 OR로 조회
}

enum FriendshipStatus { PENDING ACCEPTED BLOCKED }
```

Indexes:

- `(requesterId, status)`
- `(addresseeId, status)`
- `(status)` — 차단 row 빠른 조회용 (작은 데이터셋)

Self-FK invariant: `CHECK (requesterId != addresseeId)`.

ACCEPTED 는 한 방향 row 로 양쪽 친구 표현. BLOCKED 는 차단자
방향 row (addressee 가 차단당한 쪽). 양쪽이 서로 차단하면
2 row.

### B. API

`apps/api/src/me/friends/` 모듈 신규.

- **`POST /me/friends/requests`** body `{ username }` → PENDING
  생성
  - 자기 자신 → 400 `FRIEND_SELF`
  - 사용자 없음 → 404 `USER_NOT_FOUND`
  - 이미 PENDING (양방향 어느 row 라도) → 409 `FRIEND_REQUEST_PENDING`
  - 이미 ACCEPTED → 409 `FRIEND_ALREADY`
  - 한쪽이 BLOCKED → 403 `FRIEND_BLOCKED`
  - Rate limit: 10 requests/min/user
- **`POST /me/friends/requests/:id/accept`** → status PENDING →
  ACCEPTED. respondedAt 갱신. `friend.request.received` 이벤트
  → addressee 알림 (friend 가 수락했음을 requester 에게 알리는
  새 이벤트 `friend.request.accepted`)
- **`POST /me/friends/requests/:id/reject`** → row 삭제 (재요청
  허용)
- **`DELETE /me/friends/:userId`** → ACCEPTED row 삭제 (양방향
  관계 해소)
- **`POST /me/friends/:userId/block`** → 차단 row 생성/upsert.
  기존 ACCEPTED row 가 있으면 status → BLOCKED 로 업데이트.
  Rate limit: 5 toggles/min/user
- **`DELETE /me/friends/:userId/block`** → BLOCKED row 삭제
  (unblock; 친구 관계 자동 복원 안 함 — 새로 요청 필요)
- **`GET /me/friends?status=&cursor=&limit=50`** — `status` 필터
  옵션:
  - `accepted` — ACCEPTED 전부 (양방향 OR)
  - `pending_incoming` — 내가 addressee 인 PENDING
  - `pending_outgoing` — 내가 requester 인 PENDING
  - `blocked` — 내가 requester 인 BLOCKED
  - 빈 값 → 전부
- 응답 row: `{ friendshipId, otherUser: { id, username, avatar, status (presence) }, status, requestedAt, respondedAt? }`

### C. 데스크톱 UI

신규 route `/friends` (server rail 진입은 F-3 에서; 032 에서는
직접 URL 또는 다른 link 로 진입).

- Page layout: 좌측 `qf-tabs`:
  - 모든 친구 (ACCEPTED 카운트)
  - 온라인 (ACCEPTED + presence=online 카운트)
  - 대기중 (pending_incoming + outgoing 합계, badge 강조)
  - 차단됨 (BLOCKED 카운트)
- 우측: 친구 목록 (`qf-row` per friend):
  - avatar + status dot (`qf-avatar__status--online|dnd|offline`)
  - username + 상태 텍스트 ("온라인" / "다른 사용자 입력 중…" 같은 cue 는 OUT, 단순 status 만)
  - 우측 action menu (icon-only `more`):
    - "DM 보내기" → 027 의 createOrGet 호출 후 navigate
    - "친구 제거" → confirm dialog
    - "차단" → confirm dialog
- Pending incoming 탭:
  - row 마다 inline `accept` / `reject` 버튼 (`qf-btn`)
- Pending outgoing 탭:
  - row 마다 "요청 취소" 버튼 (DELETE friendshipId)
- Blocked 탭:
  - row 마다 "차단 해제" 버튼
- 상단 우측 "친구 추가" 버튼 → modal:
  - username text input + 송신 버튼
  - 검색 결과는 표시 안 함 (단순 send-or-error)
  - Send 후 toast "요청을 보냈습니다" / 에러 메시지
- `/friends?tab=pending` 같은 URL parameter 지원 (alert 클릭 시
  바로 해당 탭)

### D. 모바일 UI

`/friends` 모바일 viewport 진입 시 `MobileFriends.tsx`:

- `qf-m-screen` + `qf-m-topbar` (title "친구" + back button)
- `qf-m-segment` 4 탭 (모든 / 온라인 / 대기중 / 차단됨)
- `qf-m-row` per friend (avatar + primary username + secondary
  status + aside menu icon)
- Row 클릭 → `qf-m-sheet` (DM/제거/차단 액션 리스트)
- Pending incoming 탭에서는 row 우측에 accept/reject 인라인
  icon-button (44×44 hit area)
- 친구 추가 = `qf-m-fab` (`+`) → `qf-m-sheet` (username input
  - 송신 버튼)
- Mobile tabbar 는 그대로 유지 (Home/DMs/Activity/You — F-3 에서
  Home 의미 변경 시 변동)

### E. 알림 통합 (019 + 026)

- **019 enum 확장**:
  - `UserNotificationPreference.eventType` enum 에 `FRIEND_REQUEST`
    추가 (Prisma migration 의 enum ALTER)
  - 019 설정 페이지 (`/settings/notifications`) 의 row 목록에
    `FRIEND_REQUEST` 추가 (기본 channel: `BOTH`)
  - Dispatcher hardcoded fallback 도 `FRIEND_REQUEST: BOTH` 추가
- **신규 outbox event**:
  - `friend.request.received` — addressee 에게 fan-out
  - `friend.request.accepted` — requester 에게 fan-out
- **Frontend dispatcher 분기 추가**:
  - `friend.request.received` → toast (variant `friend`) + Activity
    inbox invalidate + Friends pending_incoming count +1
  - `friend.request.accepted` → toast + Activity invalidate
- **026 Activity inbox 확장**:
  - UNION query 의 5 번째 source 로 `FriendRequest`/`FriendAcceptance`
    추가
  - Activity row UI: avatar + "친구 요청을 보냈습니다" / "친구
    요청을 수락했습니다" + accept/reject 인라인 버튼 (incoming
    pending 만)
  - 026 의 4 필터 탭에 친구 관련 row 가 어떻게 보일지: 일단 "All"
    에만 등장 (별도 필터 추가 OUT — 이번 task 범위 작게)
  - `activity-friend-request-source.int.spec.ts` 신규

### F. E2E specs

`apps/web/e2e/friends/` 신규 디렉토리:

- **`friend-request-send.e2e.ts`** — A 가 username 으로 B 검색 →
  요청 전송 → B 의 Activity inbox + Friends pending_incoming 에
  표시
- **`friend-request-accept.e2e.ts`** — B 가 accept → 양쪽 ACCEPTED
  - 친구 목록에 표시 + A 에게 toast/Activity 알림
- **`friend-request-reject.e2e.ts`** — B reject → row 삭제 + A 가
  재요청 가능
- **`friend-block-flow.e2e.ts`** — A 가 B 차단 → A 입장에서 B 가
  차단 목록에 + 새 친구 요청 / DM 시도 → 403 차단
- **`friend-unblock.e2e.ts`** — A 가 차단 해제 → 차단 목록에서
  제거 (자동 친구 복원 X — 새 요청 필요)
- **`friend-mobile-fab.mobile.e2e.ts`** — 모바일 `qf-m-fab` 클릭 →
  `qf-m-sheet` → 요청 송신
- **`friend-notification-integration.e2e.ts`** — 019 설정에서
  `FRIEND_REQUEST=OFF` → 요청 받아도 toast 없음, BUT Activity
  inbox 에는 등장 (preference 는 알림 채널만 차단)

### G. develop → main auto-promote + Pane 1 auto-forward (10th)

표준 flow per `feedback_auto_promote_to_main.md` +
`feedback_pane0_auto_forward_report.md`.

## Scope (OUT)

- F-3 Home = DMs + 친구 사이드바 — 다음 task
- 친구 그룹 / favorites / 별명
- 친구 추천 / 공통 채널 기반 추천
- 휴면 친구 탐지 / cleanup
- Email 또는 phone 검색
- 그룹 DM (3+인)
- 차단 시 같은 채널에서 메시지 가림 (채널은 그대로 보임)
- 차단 시 양쪽 mention 차단 (mention 자체는 워크스페이스 권한
  영역, 친구 시스템과 직교)
- 친구 요청 보내기 시 username 추천 / autocomplete
- "사용자가 username 으로 등록 안 되어 있을 때" 추측성 매칭 결과
- Voice / Loki / PITR / mecab-ko / Custom emoji
- Friend export / import / sync from external

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- Prisma migrations (2개) reversible:
  - `add_friendship_table.sql` (Friendship + FriendshipStatus enum)
  - `extend_user_notification_preference_event_type.sql`
    (`FRIEND_REQUEST` 값 추가)
- `pnpm --filter @qufox/api test:int` green, 신규:
  - `friend-request.int.spec.ts` (요청/accept/reject/edge 8+
    cases: self/duplicate/blocked-direction/rate-limit)
  - `friend-block.int.spec.ts` (block + unblock + 차단 시 새 요청
    거부 + 차단 시 DM 거부)
  - `friend-list-query.int.spec.ts` (4 status filter + cursor
    pagination + 정렬)
  - `activity-friend-request-source.int.spec.ts` (UNION 5 source
    - ACL filter)
- `pnpm --filter @qufox/web test:e2e` green, 신규 7 specs (위 § F)
- 모바일 viewport 에서 `/friends` 정상 렌더 (qf-m-screen +
  qf-m-segment + qf-m-fab DOM 존재)
- Rate limit 429 검증:
  - 친구 요청 11회/분 → 11회째 429 + Retry-After
  - 차단 토글 6회/분 → 6회째 429
- 자기 자신 친구 요청 → 400 검증 (E2E 또는 int spec)
- 019 `FRIEND_REQUEST` enum + 설정 페이지 row 표시 grep 증거
- 026 Activity 의 friend_request source row 가 inbox 에 표시
  (E2E)
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched
- qf-m-\* 사용 카운트 약간 증가 (모바일 friends UI)
- 3 artefacts: `032-*.md`, `032-*.PR.md`, `032-*.review.md`
- 1 eval: `evals/tasks/043-friends-system.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` (path `/volume2/dockers/qufox-deploy/.deploy/`)
  last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 10번째 적용**
- FINAL REPORT 자동 출력, 포함 항목:
  - develop/main SHA + exitCode + /readyz + idle + wall
  - 청크별 A~G 산출물 표
  - Friendship row 수 (test fixture 기준)
  - Rate limit 429 실전 증거 (curl 또는 int spec 출력)
  - 019 + 026 통합 증거 (E2E pass)
  - F-3 (Home = DMs) 다음 task 가능성 안내
  - Deferred TODO(task-032-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 031 merged + deployed (`a6f7ec5` main)
- 027 의 1:1 DM (`Channel.type=DIRECT` + `DirectMessageService.createOrGet`)
  활성 — friend menu 의 "DM 보내기" 가 호출
- 019 `UserNotificationPreference` 테이블 + dispatcher infrastructure
  활성 (FRIEND_REQUEST 추가는 enum ALTER + 1 dispatcher 분기)
- 026 Activity UNION query (mention/reply/reaction/direct 4 source) —
  5번째 friend_request 추가
- 005 의 Redis sliding window rate limit 패턴
- DS `qf-tabs`, `qf-row`, `qf-m-segment`, `qf-m-row`, `qf-m-fab`,
  `qf-m-sheet` 활용 가능

## Design Decisions

### 한 방향 row + OR 쿼리

Discord 모델. ACCEPTED 친구 관계가 양방향 row 면 중복 데이터 +
일관성 부담. requester→addressee 한 방향만 저장하고 양쪽 관점
조회 시 `(requesterId=me OR addresseeId=me) AND status=ACCEPTED`
로 OR 쿼리. unique constraint 가 (requesterId, addresseeId) 라
같은 방향 중복 방지.

### 차단은 "한 방향 row" 도 동일

차단자 → 차단대상. 양쪽이 서로 차단하면 2 row. 차단 시 PENDING
이나 ACCEPTED row 가 있으면 BLOCKED 로 status 업데이트 + 차단자
direction 정렬.

### Username 정확 매칭만

substring 검색 / autocomplete 는 PII enumeration 위험. "사용자가
존재하지만 자기 자신을 모름" 시나리오 차단. enumerate 가능성
낮음 (username 정확 입력 필요).

### 차단 시 기존 DM 채널은 유지

027 DM 은 Channel + ChannelPermissionOverride 기반. 차단 시
override 를 DENY 로 flip 하면 메시지 송신 차단되지만 채널
자체는 유지 → 양쪽이 이전 history 볼 수 있음. 데이터 손실 없는
shape. 새 메시지 송신은 양쪽 모두 차단.

### 알림은 Activity + toast (019 default BOTH)

019 의 4 channel (TOAST/BROWSER/BOTH/OFF) 동일 적용. 사용자
설정에 따라 toast 끄거나 켜기. Activity 는 항상 기록 (이력
추적).

### Standalone `/friends` page, server rail entry 는 F-3에서

032 가 server rail entry 까지 추가하면 F-3 의 Home 재배치 작업과
충돌. 032 는 데이터 + 기본 UI 만, F-3 가 Home + 친구 사이드바
통합.

### 친구 1000 cap

`UserCapsService` 또는 service-layer guard 로 ACCEPTED row 수
1000 도달 시 새 요청 거부 (`FRIEND_LIMIT`). 베타에서 충분하고
운영 sanity check.

## Non-goals

- F-3 Home = DMs 통합
- 그룹 DM
- 친구 별명 / favorites
- 친구 추천
- Username autocomplete
- Email/phone 검색
- 차단 시 mention 자동 가림
- friend feed / activity log

## Risks

- **이미 친구 / 차단 / pending 중복 케이스 8 가지**: A→B PENDING /
  B→A PENDING / ACCEPTED / A→B BLOCKED / B→A BLOCKED / 양방향
  BLOCKED / no relation / self. int spec 에서 8 케이스 enumerate
- **알림 중복**: 026 Activity + 019 toast 둘 다 같은 row 처리
  지점 — dispatcher 가 중복 호출 안 하도록 단일 분기에서 둘
  다 invalidate
- **Username uniqueness**: User.username 이 unique 인지 002 확인
  필요. 그렇지 않으면 친구 요청에서 모호. UNDERSTAND 에서 확인;
  unique 아니면 별도 task 로 빼거나 `userId` 기반으로 변경
- **027 DM 채널 차단**: createOrGet 가 차단된 사용자 사이에
  호출되면 어떤 응답? 신규 채널 생성 X + 403. 027 service 에
  차단 체크 분기 추가
- **Friend 차단이 워크스페이스 권한과 분리**: 같은 워크스페이스
  멤버는 그대로 채널에서 메시지 보임. 사용자 기대와 다를 수
  있음 → "차단해도 같은 서버에서는 메시지 보입니다" 도움말
  toast (또는 차단 모달 안내)
- **Activity row 의 accept/reject inline 버튼 중복 클릭**:
  optimistic + idempotent guard. 더블 클릭 시 두 번째는 409
- **Rate limit 임계값**: 친구 요청 10/min, 차단 5/min — bot 아닌
  사용자에겐 충분히 넓음. reviewer 피드백 따라 조정
- **차단 후 자동 친구 해제**: BLOCKED 가 ACCEPTED 를 덮어쓸 때
  respondedAt 등 metadata 보존 vs 초기화. 채택: requestedAt 유지
  - respondedAt 갱신 (BLOCKED 시점 기록)

## Progress Log

_Implementer 채움_

- [ ] UNDERSTAND (User.username unique 확인, 027 DM service 차단
      체크 추가 가능 영역, 019 enum migration 패턴, 026 Activity
      UNION query, qf-tabs / qf-row primitive 시그니처)
- [ ] PLAN approved
- [ ] SCAFFOLD (migration red, friend-request controller stub,
      /friends page skeleton, 모바일 MobileFriends skeleton, int
      spec red)
- [ ] IMPLEMENT (A → B → E → C → D → F)
- [ ] VERIFY (`pnpm verify` + GHA int + e2e green)
- [ ] OBSERVE (8 케이스 매트릭스 int spec pass, rate limit 429
      curl, 019 + 026 통합 grep)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT auto-printed + **pane 1 auto-forwarded 10th**)
