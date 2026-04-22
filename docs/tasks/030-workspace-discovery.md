# Task 030 — Workspace Discovery (공개 워크스페이스 찾기 + 참가) → main deploy

## Context

qufox 는 지금까지 invite 기반 가입만 있었고 PUBLIC 워크스페이스
개념이 없었습니다. 사용자가 관심사(카테고리) 기반으로 공개된
워크스페이스를 찾고 **즉시 참가**할 수 있어야 베타 확장이 가능.

Task 030 은 다음 셋을 같이 합니다:

1. `Workspace` 에 `visibility` + `category` + `description`
   컬럼 추가 (PRIVATE default, 기존 data 영향 없음)
2. **워크스페이스 생성 시 UI에 "공개 여부" 토글 + "카테고리
   selector" 추가** — 공개 선택 시 카테고리 + description 필수
   (사용자 강조)
3. 서버 레일의 `+` 버튼 **아래**에 "찾기" 버튼 신설 + `/discover`
   페이지 (카테고리 필터 + 검색 + 참가)

## Scope (IN) — 9 chunks

### A. DB + Schema

- Prisma migration (reversible):
  ```
  Workspace {
    ...existing
    visibility   WorkspaceVisibility @default(PRIVATE)  -- enum PRIVATE | PUBLIC
    category     WorkspaceCategory?                       -- enum, null when PRIVATE
    description  String?                                  -- 500 char cap, null when PRIVATE
  }
  ```
- `visibility` NOT NULL + default PRIVATE (metadata-only ALTER).
- 기존 모든 Workspace는 PRIVATE — OWNER가 전환해야 PUBLIC.
- Invariant (SQL CHECK 또는 서비스 레벨):
  - `visibility=PUBLIC` → `category IS NOT NULL AND description IS NOT NULL`
  - `visibility=PRIVATE` → `category` / `description` 존재해도 무해 (토글 revert 시 재입력 불필요)

### B. Category enum (고정 8개)

shared-types + Prisma 모두 반영:

```
WorkspaceCategory {
  PROGRAMMING
  GAMING
  MUSIC
  ENTERTAINMENT
  SCIENCE
  TECH
  EDUCATION
  OTHER
}
```

라벨 / 아이콘 매핑은 클라이언트 상수 테이블 (신규
`apps/web/src/features/workspaces/categoryMeta.ts`):

```
PROGRAMMING: { label: '프로그래밍', icon: 'code' }
GAMING:      { label: '게이밍',    icon: 'gamepad' }
MUSIC:       { label: '음악',      icon: 'music' }
ENTERTAINMENT:{label:'엔터테인먼트', icon:'megaphone' }
SCIENCE:     { label: '과학',      icon: 'flask' }
TECH:        { label: '기술',      icon: 'cpu' }
EDUCATION:   { label: '교육',      icon: 'book' }
OTHER:       { label: '기타',      icon: 'more' }
```

Icon 이름은 `icons.svg` 있는 것만 사용; 없으면 가장 가까운
대체.

### C. API

- `GET /workspaces/discover?category=&q=&cursor=&limit=20`
  - PUBLIC 만 반환 (PRIVATE 무조건 제외)
  - `q` 는 name + description substring (server-side ILIKE)
  - 정렬: `(member_count DESC, last_activity_at DESC)`
  - Response: `{ results: [{ id, slug, name, iconUrl?, description, category, memberCount, lastActivityAt }], nextCursor }`
- `POST /workspaces/:id/join`
  - PUBLIC 전용 (PRIVATE → 403 `WORKSPACE_NOT_PUBLIC`)
  - 이미 멤버면 200 + `{ alreadyMember: true }` (idempotent)
  - 비로그인: 401 → FE 가 `/signup?redirect=/discover` 혹은 `/login` 으로 우회
  - Rate limit: **5 joins/min/user**
  - 기본 role: `MEMBER`
- `PATCH /workspaces/:id` (기존 endpoint 확장 또는 새
  `PATCH /workspaces/:id/visibility`):
  - body `{ visibility?, category?, description? }`
  - OWNER 만; ADMIN 거부
  - PUBLIC 전환 시 category + description NOT NULL 강제
  - PRIVATE 전환 시 기존 멤버 유지 (kick 없음)
  - Rate limit: **10/hour/workspace** (토글 스팸 방지)

### D. CreateWorkspacePage UI 수정 — **사용자 강조 필수**

- 기존 form에 새 필드 **3개** 추가:

  1. **공개/비공개 radio 또는 toggle**
     - label: "워크스페이스 공개 여부" (default: 비공개)
     - 옵션: `비공개` / `공개`
  2. **카테고리 selector** (공개 선택 시 표시 + required):
     - `<select>` 또는 DS `qf-select` 로 8 카테고리 한글 라벨
     - default placeholder "카테고리를 선택하세요"
  3. **설명 textarea** (공개 선택 시 표시 + required, 500자):
     - label: "워크스페이스 소개"
     - placeholder: "다른 사용자가 참가할 때 보이는 소개글 (최대 500자)"
     - character counter

- 비공개 선택 시 카테고리/설명 필드 `display:none` — 값 제출
  X (null)
- 공개 선택 후 카테고리 또는 설명 공란이면 submit 비활성화 +
  inline 에러 message
- 서버측 재검증 (zod schema): PUBLIC → category + description NOT NULL
- 기존 `POST /workspaces` 요청 body schema에 `visibility` /
  `category?` / `description?` 추가
- E2E: `create-public-workspace.e2e.ts` (공개 토글 → 카테고리
  선택 → 설명 입력 → 생성 → Discovery 에서 노출 확인)
- E2E: `create-private-workspace-keeps-existing-behavior.e2e.ts`
  (비공개 토글 default 로 생성 → 카테고리/설명 request body
  에 미포함 → Discovery 에 미노출)

### E. 데스크톱 Discovery page

- Server rail:
  - 최하단 순서: `+` (생성) → **"찾기" (신규)** → (DMs — 027에서
    추가한 것)
  - `qf-server-btn` + Icon `compass` (icons.svg 확인; 없으면
    `search`)
  - 클릭 → `/discover` route
  - aria-label "공개 워크스페이스 찾기"
- `/discover` 페이지:
  - 상단: 페이지 title "찾기" + 검색 input (`qf-input`,
    placeholder "이름 / 설명으로 검색", debounce 300ms)
  - 카테고리 chip row: "전체" + 8 카테고리 (활성 chip 은
    `qf-tab--active` 스타일)
  - Card grid: workspace card (`qf-card` 또는 inline primitive):
    - 아이콘 + name + category badge + description (truncate) +
      member count + last activity time
    - "참가" CTA 버튼 (`qf-btn qf-btn--primary`)
    - 이미 멤버인 워크스페이스는 "참여 중" disabled 표시
  - 빈 상태: `qf-empty` + "해당 카테고리에 공개 워크스페이스가
    없습니다"
  - cursor pagination: "더 보기" 버튼
- 참가 성공 → `/w/:slug` 이동

### F. 모바일 Discovery page

- `/discover` 모바일 viewport: `useBreakpoint` 가 mobile 이면
  `MobileDiscover.tsx` 렌더
- 구조:
  - `qf-m-screen`
  - `qf-m-topbar` (title "찾기" + back button)
  - `qf-m-segment` 8 카테고리 + "전체" (가로 스크롤)
  - `qf-m-search` + `qf-m-search__input` (검색)
  - `qf-m-row` per workspace (icon + primary name + secondary
    description + aside member count) + 참가 버튼 (인라인 또는
    row 클릭 → detail sheet)
  - `qf-m-tabbar` 유지 (Discovery 는 tabbar 아님)
- E2E: `workspace-discovery-mobile.mobile.e2e.ts` (ScreenDiscover
  parity + 카테고리 전환 + 참가)

### G. Workspace settings 에 visibility 전환

- 기존 channel-settings 패턴 재사용 (012 + 018 의 SettingsOverlay)
- Workspace settings panel 신규 또는 기존 확장:
  - "공개 여부" toggle (OWNER 만 활성화 가능, ADMIN 은 read-only)
  - 공개 전환 시 카테고리 selector + description 입력 노출
  - 비공개 전환 시 경고 toast "기존 멤버는 유지되며 Discovery
    에서만 제외됩니다"
  - 저장 버튼 → `PATCH /workspaces/:id`
- E2E: `workspace-visibility-toggle.e2e.ts` (OWNER toggle OK,
  ADMIN toggle 거부, 카테고리 공란 시 저장 실패)

### H. E2E & 회귀

신규 E2E 전체 목록 (4 desktop + 1 mobile):

- `create-public-workspace.e2e.ts` (D)
- `create-private-workspace-keeps-existing-behavior.e2e.ts` (D)
- `workspace-discovery-desktop.e2e.ts` (E)
- `workspace-visibility-toggle.e2e.ts` (G)
- `workspace-public-join-flow.e2e.ts` (C — 로그인 리디렉트 + rate
  limit)
- `workspace-discovery-mobile.mobile.e2e.ts` (F)

Int spec 신규 (3):

- `discovery-list.int.spec.ts` — 필터 + 페이지네이션 + PRIVATE
  제외 + 정렬
- `workspace-join.int.spec.ts` — PUBLIC 가입 + idempotent + PRIVATE
  거부 + rate limit
- `visibility-toggle.int.spec.ts` — OWNER only + category 필수
  검증

### I. develop → main auto-promote + pane 1 auto-forward (8th)

표준. 특히 **사용자 실 기기 확인 요청 항목**:

- `/discover` 모바일에서 카테고리 chip 스크롤
- 공개 토글 on 상태로 워크스페이스 생성 시 카테고리 + 설명
  필드가 보이는지
- 참가 버튼 실제 동작 확인

## Scope (OUT) — 미래 task

- 승인 기반 참가 (request-to-join)
- 복수 카테고리
- 카테고리 admin 관리 UI (현재는 enum 고정)
- 추천 / trending / 인기 ranking 튜닝
- FTS 검색 (substring 만)
- 스폰서 / 프로모션 카드
- 좋아요 / 북마크 / follow
- 비공개 워크스페이스의 "request-only" visibility (PRIVATE 이면
  완전 비공개)
- 참가 후 강제 onboarding 변경

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- Prisma migration reversible (visibility + category + description
  3 컬럼 + Workspace 기존 rows 모두 PRIVATE 로 backfill 확인)
- `pnpm --filter @qufox/api test:int` green, 신규:
  - `discovery-list.int.spec.ts`
  - `workspace-join.int.spec.ts`
  - `visibility-toggle.int.spec.ts`
- `pnpm --filter @qufox/web test:e2e` green, 신규 6 specs:
  - `create-public-workspace.e2e.ts`
  - `create-private-workspace-keeps-existing-behavior.e2e.ts`
  - `workspace-discovery-desktop.e2e.ts`
  - `workspace-visibility-toggle.e2e.ts`
  - `workspace-public-join-flow.e2e.ts`
  - `workspace-discovery-mobile.mobile.e2e.ts`
- **CreateWorkspacePage 에 `visibility` toggle + category
  selector + description textarea 3개 필드 DOM 존재** — E2E 가
  assert
- **서버 레일 DOM 순서 테스트**: `+` 버튼 → `찾기` 버튼 → DMs 버튼
  순 (desktop)
- 기존 워크스페이스 생성 flow (비공개) 회귀 없음 (002 의 기존
  e2e 통과)
- DS mobile.css / tokens.css / components.css / icons.css
  untouched
- 3 artefacts: `030-*.md`, `030-*.PR.md`, `030-*.review.md`
- 1 eval: `evals/tasks/041-workspace-discovery.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` (path `/volume2/dockers/qufox-deploy/.deploy/`)
  last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 8번째 적용**
- FINAL REPORT 자동 출력, 포함 항목:
  - develop/main SHA + exitCode + /readyz + idle + wall
  - Chunks A–I 산출물 표
  - **CreateWorkspacePage 3 신규 필드 (visibility/category/description)
    정상 동작 캡처 또는 grep 증거**
  - 기존 Workspace rows 모두 PRIVATE backfill confirmed
  - 서버 레일 신규 "찾기" 버튼 위치 confirmed
  - Deferred TODO(task-030-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 029 merged + deployed (`40f5d29` main), 모바일 CSS wiring 정상
- `SettingsOverlay` primitive (012 + 018) 재사용
- Category 별 Icon 필요 시 `icons.svg` 에 이미 존재 (관련 아이콘
  audit, 없으면 대체)
- 018 ESLint 팔레트 규칙 / raw cleanup 규칙 적용
- 019 boot-time assert ENV (변경 없음)

## Design Decisions

### 카테고리는 고정 enum, 단일 선택

자유 입력은 spam / 오타 / 중복 관리 부담. 8개면 베타 확장 대응
충분. 추가는 enum 확장 (reversible migration). 복수 카테고리는
검색 복잡도 + UI 부담으로 OUT.

### 참가는 승인 없이 즉시 (사용자 명시 요청)

"참가하기" 버튼 클릭 → 1 step. admin 승인 flow는 추가 UI +
state + 알림 복잡. 베타 수준에서는 OUT. 스팸 대응은 rate
limit + 워크스페이스별 kick 권한 (002의 member kick 기능) 로
충분.

### 기존 invite 시스템 공존

PUBLIC 워크스페이스도 OWNER 가 invite 발급 가능. 두 경로 모두
`POST /workspaces/:id/members` 로 수렴.

### 기존 Workspace default PRIVATE

OWNER 가 의도적으로 PUBLIC 전환해야 Discovery 노출. 자동
migration 으로 public 이 되면 예상 못한 사용자에게 노출되는
privacy 이슈.

### Description 500자 cap

너무 길면 card layout 깨짐. Markdown / emoji 허용하되 HTML 은
sanitize. 015 search snippet 패턴과 동일한 sanitizer 재사용.

### 비로그인 접근

`/discover` 는 비로그인에도 접근 가능 (공개 워크스페이스 목록
자체는 공개 정보). 참가 버튼 클릭 시 비로그인이면 `/signup`
혹은 `/login?redirect=/discover` 로 이동. 016 의 beta-invite
flow 와 상호작용 검토 필요 (PUBLIC join 이 invite 우회이므로).

### 서버 레일의 "찾기" 위치

`+` (생성) 바로 아래, DMs 위. 사용자 직관: 왼쪽에서 오른쪽으로
내려가며 "만들기 → 찾기 → 사용자와 대화하기". icons: `plus`
→ `compass` → `message` 순.

## Non-goals

- 공개 워크스페이스 자동 추천 / feed 화면
- "trending" / "인기" 섹션
- FTS 고급 검색
- 워크스페이스 후원 / 프로모션
- 카테고리 custom / 자유 입력
- 복수 카테고리
- Request-to-join (승인 기반)
- 참가 후 초기 channel 자동 구독

## Risks

- **사용자 강조 — CreateWorkspacePage UI 필드 누락 위험**:
  토글 / 카테고리 / description 3 필드가 빠지면 Discovery 로
  노출될 워크스페이스 생성 자체가 막힘. 실수 방지 — D 의 E2E
  2개 + Acceptance 에 명시적으로 필드 존재 assert.

- **Postgres enum 값 추가 migration**: `WorkspaceCategory` enum
  이 Prisma schema 에 새로 추가되므로 migration 이 `CREATE TYPE`
  실행. down script 는 타입 제거 (복잡) 또는 "no-op" 주석. 기존
  practice 와 일관.

- **기존 Workspace rows 의 backfill**: 전부 PRIVATE default.
  Postgres default 가 metadata-only ALTER 라서 대량 rewrite 없음.
  다만 `category` / `description` 는 nullable 이라 backfill
  불필요.

- **Discovery list query 성능**: PUBLIC workspace 수가 많아지면
  `(member_count, last_activity_at)` 정렬 + ILIKE 검색 비효율.
  partial index `CREATE INDEX workspaces_public_idx ON workspaces
(member_count DESC, last_activity_at DESC) WHERE visibility='PUBLIC'`
  추가. 베타 규모 (100–1000 workspaces) 에서는 sufficient;
  수십만 이상 시 FTS 로 확장.

- **참가 flow 와 016 beta-invite-required 중첩**: `BETA_INVITE_REQUIRED=true`
  이면 가입 자체가 invite 필요. Discovery 로 워크스페이스 찾고
  "참가" 클릭 시 비로그인이면 signup 으로 갈 텐데, signup 자체가
  beta-gate 로 막힘. mitigation: 016 설정이 켜져있으면 Discovery
  페이지의 참가 버튼이 "초대가 있어야 가입 가능합니다" 안내 +
  워크스페이스 OWNER 초대 요청 방법 안내. 구현 cost 작으므로 C
  의 edge case 에 포함.

- **visibility 토글 rate limit 이 운영자 짜증**: 10/hour 는 충분.
  운영 도중 설정 반복 수정이 거의 없음. 사용자가 필요 시 ENV
  override.

- **카테고리 icon 누락**: `flask` / `gamepad` / `cpu` 등 `icons.svg`
  에 없을 수 있음. UNDERSTAND 에서 확인. 없으면 가장 가까운
  대체 (`beaker` → flask 대체 등).

- **Description sanitizer 로 markdown 안 깨지는지**: 015 search
  snippet 의 `ts_headline` 결과가 비슷한 HTML 포함이므로 동일
  DOMPurify 호출로 충분. emoji 는 plain text 라 무해.

## Progress Log

_Implementer 채움_

- [ ] UNDERSTAND (Prisma Workspace 스키마 현황, Category icon
      mapping audit, 002 create flow zod schema, 016 invite-gate
      edge case, SettingsOverlay primitive 재사용 가능성)
- [ ] PLAN approved
- [ ] SCAFFOLD (migration red, Discovery controller stub,
      CreateWorkspacePage 필드 stub, 서버 레일 버튼 stub)
- [ ] IMPLEMENT (A → B → C → D → E → F → G)
- [ ] VERIFY (`pnpm verify` + GHA int + e2e green)
- [ ] OBSERVE (`GET /workspaces/discover` EXPLAIN 캡처,
      CreateWorkspacePage 3 신규 필드 존재 grep 증거, 서버 레일
      "찾기" 버튼 순서 DOM snapshot)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT auto-printed + **pane 1 auto-forwarded 8th**)
