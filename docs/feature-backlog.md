# Feature Backlog (future tasks)

Proposed product features, not yet scheduled as tasks. pane 1
writes here when the user names a feature in conversation so it
doesn't live only in chat history. Each item becomes a full task
doc under `docs/tasks/NNN-*.md` when it enters active work.

Ordering here is **dependency-aware**, not commitment — user picks
which to start, in which order, when the current sprint settles.

---

## F-1. Workspace Discovery (찾기 기능)

**User ask (2026-04-23):**

- 공개된 워크스페이스를 찾아 "참가하기" 가능
- 가장 왼쪽 워크스페이스 레일에 워크스페이스 생성(+) 버튼 **아래에**
  신규 버튼 "찾기" 추가
- 워크스페이스 생성 시 **공개/비공개** 결정 → 공개인 경우 관심사
  (카테고리) 지정
- 카테고리 예시: 프로그래밍 · 게이밍 · 음악 · 엔터테인먼트 · 과학
  · 기술 · 교육

### Design sketch

- Prisma: `Workspace.visibility` enum (`PRIVATE` default |
  `PUBLIC`) + `Workspace.categories text[]`
- 카테고리는 고정 enum 또는 workspace admin이 자유 입력 (user
  answer 필요)
- API:
  - `GET /workspaces/discover?category=&cursor&limit=20` — PUBLIC
    만 반환, 각 항목에 `{ id, name, slug, description, category,
memberCount, recentActivityAt, iconUrl }`
  - `POST /workspaces/:id/join` — 누구나 가능 (invite code
    우회), PUBLIC 워크스페이스에만 허용, rate limit 5/min
- UI:
  - 데스크톱: server rail `+` 아래에 `qf-server-btn` (Icon
    `compass`) — 클릭 시 `/discover` route
  - `/discover` 페이지: category filter (`qf-tabs` 또는 chip
    row) + workspace cards grid + 검색 input + "참가" CTA per
    card
  - 모바일: `/discover` 별도 route, `qf-m-screen` + `qf-m-segment`
    categories + `qf-m-row` per workspace
- 공개 설정은 workspace settings에서 토글 (OWNER만)
- **Prerequisite**: 002 invite system과 공존 (PUBLIC workspace도
  invite 기반 가입 병행 가능)
- Scope OUT: 추천 알고리즘, 인기도 ranking, 추천 카테고리 자동
  생성, 검색 FTS (기본 name/description substring만)

### Estimated size

2.5–3일

### Proposed task number

Task 031 (또는 Task 033; Friends 보다 독립적이라 먼저 가도 됨)

---

## F-2. Friends System

**User ask (2026-04-23):**

- 친구 기능 (구체 플로우는 언급 안 됨, 암묵적으로 F-3의 "친구 목록"
  데이터 소스가 됨)

### Design sketch

- Prisma:
  ```
  Friendship {
    id              uuid pk
    requesterId     uuid fk -> User.id
    addresseeId     uuid fk -> User.id
    status          enum PENDING | ACCEPTED | BLOCKED
    requestedAt     timestamptz
    respondedAt     timestamptz?
    unique (requesterId, addresseeId)  -- 한 방향만 유지; 양방향 쿼리로 조회
  }
  ```
- API:
  - `POST /me/friends/requests` body `{ userId | username }` →
    PENDING 생성 (자기 자신 거부, 이미 ACCEPTED면 409, BLOCKED
    이면 403)
  - `POST /me/friends/requests/:id/accept` → ACCEPTED + 양쪽에
    친구 관계 성립
  - `POST /me/friends/requests/:id/reject` → row 삭제
  - `DELETE /me/friends/:userId` → 친구 관계 삭제 (양쪽 모두)
  - `POST /me/friends/:userId/block` → BLOCKED (양쪽 차단)
  - `GET /me/friends?status=accepted|pending|blocked`
- UI:
  - 친구 추가는 "사용자 이름으로 검색" → "친구 요청 보내기"
    (Discord 방식)
  - Online / Offline / DnD 상태 표시 (005 presence 재사용)
  - 요청 받은 건 badge + accept/reject 버튼
- 알림:
  - 019 notification preferences 에 `FRIEND_REQUEST` eventType
    추가 (019-C enum 확장)
  - 026 Activity inbox 에 `type=friend_request` 추가
- Scope OUT: 친구 그룹(favorites), 친구 추천, 공통 채널 기반 추천,
  친구 안 휴면 탐지, 2FA for 요청 확인 등
- **Prerequisite**: 027 (DMs) 완료됨. Friends는 DM 초대처럼
  사용되므로 027 API 재사용

### Estimated size

3–4일

### Proposed task number

Task 031 or 032 (F-3 전에 필요)

---

## F-3. Home = Direct Messages (재배치 + 친구 사이드바)

**User ask (2026-04-23):**

- 현재의 Home 버튼이 **DM 화면으로 이동**
- DM 화면의 **왼쪽 메뉴** (워크스페이스 화면의 채널 리스트 영역):
  - **최상단: "친구" 메뉴** — 클릭 시 메시지 영역에 친구 목록 +
    상태 + DM 시작
  - **하단: 친구 목록** — 친구 클릭 시 메시지 영역에 그 친구와의
    DM
- **PC 버전**: 친구 메뉴 아래 "활동" 메뉴 — 현재 모바일에만
  있는 Activity inbox를 PC DM 화면으로 이식
- 모바일은 현재 UI에 맞게 적절히 (tabbar의 Home → DM 화면이
  이미 현재 `/dms` 경로; 거의 정착된 상태)

### Design sketch

- 데스크톱 네비 재배치:
  - Server rail의 기존 "Home" (워크스페이스 기본 진입점) 을
    **"DMs Home"** 으로 change → 클릭 시 `/home` (또는 global
    `/dms`)
  - `/home` 페이지:
    - 좌측 column (qf-channellist 같은 폭):
      - `qf-m-row` 또는 유사한 전용 primitive
      - "친구" 메뉴 (최상단, 전체 카테고리 토글)
      - "활동" 메뉴 (친구 아래)
      - 친구 목록 (status 정렬: online 먼저)
    - 메시지 영역: 선택된 항목에 따라 전환
      - "친구" 선택 → 친구 리스트 전체 화면 (추가/수락/차단
        관리)
      - "활동" 선택 → 026의 `/activity` 페이지 내용
      - 친구 클릭 → 해당 친구와의 DM (워크스페이스 스코프 없으면
        "global DM", 있으면 027 워크스페이스 DM 재사용)
- 모바일:
  - 현재 tabbar `Home` 이 `/w/:slug` 였다면 → `/home` 또는
    `/dms` 로 재정의 (user's note: "모바일은 현재 UI에 맞게")
  - 큰 변경 없음; 이미 `/dms` 탭이 DM 목록임
- 워크스페이스 스코프 vs global:
  - 027은 per-workspace DM. F-3의 Home은 workspace 무관 Friends
    기반
  - → **Friends DM은 global** (workspace 무관) 로 새로 만들거나
    027 확장. user decision 필요
  - 설계 결정: global DM 채널 도입 (`Channel.workspaceId` nullable
    or separate `DirectChannel` 테이블)
- **Prerequisite**: F-2 Friends (친구 목록 데이터 원천), 026
  Activity, 027 DMs
- Scope OUT: DM 방향 voice/video, group DM (OUT 도 아님; F-3
  이후 자연스러운 확장), scheduled DM, DM archive

### Estimated size

3–4일 (F-2 완료 가정 시)

### Proposed task number

Task 032 or 033 (F-2 뒤)

---

## 순서 의존 그래프

```
F-1 (Workspace Discovery)        — 독립 / 어느 순서든 OK
    ↓
F-2 (Friends System)             — F-3의 선행 조건
    ↓
F-3 (Home = DMs + Friends)       — F-2 + 027/026 재사용
```

권장 흐름:

- **옵션 X**: F-1 → F-2 → F-3 (3개 순차, 8–10일 누적)
- **옵션 Y**: F-2 → F-3 → F-1 (social 우선, 8–10일)
- **옵션 Z**: 030은 Loki/PITR로 운영 안정화, 이후 F-1~3 순차 (병렬
  안 할 때)

## 기타 대기 feature (미네임드)

- Voice channel (task-028 원래 slot; WebRTC SFU)
- Group DMs (3+인) — 027 확장
- Custom emoji upload
- 한국어 mecab-ko FTS
- Loki 자체 호스팅
- PITR/WAL + sops/age
