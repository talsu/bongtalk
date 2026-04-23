# Task 031 — 030 Follow Sweep (Settings UI + Rate Limits + Int Specs + ILIKE + Sort Tie-break) → main deploy

## Context

030 (Workspace Discovery) 가 core 를 ship 하고 030-follow 가
server rail UX 를 잡았지만, 030 의 9 chunks 중 G/D-2/D-3/D-4/
D-5 가 deferred 로 남았습니다. 특히:

- **D-1 (G)**: OWNER 가 기존 워크스페이스를 PUBLIC 전환할 UI
  가 없음. 030 API 는 있지만 사용자가 수동 curl 해야 함 → 실
  사용성 막힘 (HIGH)
- **D-2**: `POST /workspaces/:id/join` + `PATCH /workspaces/:id/visibility`
  rate limit 미구현 → join spam 취약점 (HIGH)
- **D-3**: int spec 3개 (discovery-list / workspace-join /
  visibility-toggle) 누락 → 회귀 안전망 약함
- **D-4**: 검색이 `name` 만 ILIKE → `description` 까지 확장
- **D-5**: sort tie-break 누락 → cursor pagination 결과 불안정

031 은 이 5 건을 한 sweep 으로 정리합니다. 030 reviewer 가
잡았던 BLOCKER-1 (ADMIN visibility flip) 은 c001af8 에서
in-branch fix 됐으므로, settings UI 도 그 invariant 를 따라
ADMIN 에게 read-only 로 보여줍니다.

## Scope (IN) — 5 chunks

### A. D-1 — Workspace Settings UI (visibility 전환)

- `/w/:slug/settings` 경로:
  - 기존 워크스페이스 settings route 가 있는지 UNDERSTAND 에서
    확인. 있으면 새 "공개 설정" 탭 추가, 없으면 신규 page
    `apps/web/src/features/workspaces/WorkspaceSettingsPage.tsx`
- 사용 컴포넌트: `SettingsOverlay` primitive (012 + 018 channel
  settings 패턴 재사용)
- 입력 필드 (CreateWorkspacePage 의 D 와 동일 shape):
  1. **공개 여부** radio: `비공개` / `공개` — default 는 현재 값
  2. **카테고리 selector** (공개 선택 시 표시 + required) —
     030 의 8 enum + categoryMeta 라벨/아이콘 재사용
  3. **설명 textarea** (공개 선택 시 표시 + required, 500자) —
     character counter
- OWNER 만 편집 가능; ADMIN 이 페이지 진입 시 입력 disabled +
  "OWNER 만 변경 가능" 안내 inline 메시지
- 저장 → `PATCH /workspaces/:id` (030 API). 응답 OK 시 toast
  "공개 설정이 변경되었습니다"
- PRIVATE → PUBLIC 전환 시 confirm dialog "이 워크스페이스가
  Discovery 에 노출됩니다. 계속하시겠습니까?"
- PUBLIC → PRIVATE 전환 시 confirm "기존 멤버는 유지되며
  Discovery 에서만 제외됩니다"
- E2E `workspace-visibility-toggle.e2e.ts` (OWNER OK / ADMIN
  reject / category 공란 시 저장 실패)

### B. D-2 — Rate limits

`apps/api/src/common/rate-limit/` 에서 005 가 도입한 Redis
sliding window 패턴 재사용 (이미 011 / 013 / 015 / 016 / 027 등
여러 곳에서 사용 중).

- `POST /workspaces/:id/join`:
  - 5 joins/min/user
  - 초과 시 429 + body `{ code: 'RATE_LIMITED', resetIn: <seconds> }`
    - `Retry-After` 헤더
- `PATCH /workspaces/:id/visibility` (또는 030 의 visibility
  endpoint):
  - 10 flips/hour/workspace (per workspace, not per user — OWNER
    이 토글 spam 도 막음)
  - 초과 시 동일 429 응답 형식
- `@RateLimit({ key: 'workspace-join', limit: 5, windowSec: 60 })`
  데코레이터 패턴
- 두 endpoint 의 controller 에 적용
- `apps/api/test/int/rate-limit/workspace-rate-limits.int.spec.ts`
  신규 — 두 endpoint 모두 limit 직전 / 초과 시나리오

### C. D-3 — Int specs 3개 (회귀 안전망)

- **`discovery-list.int.spec.ts`**:
  - PUBLIC 만 반환 (PRIVATE 제외)
  - category filter 정확성
  - cursor pagination (next page 가 이전 page 와 겹치지 않음)
  - 정렬 `(member_count DESC, last_activity_at DESC, id ASC)`
    deterministic
  - search `q` substring (name + description)
  - 빈 결과 처리
- **`workspace-join.int.spec.ts`**:
  - PUBLIC 가입 성공 → 멤버 추가
  - 두 번째 호출 → idempotent 200 + `{ alreadyMember: true }`
  - PRIVATE 거부 → 403 `WORKSPACE_NOT_PUBLIC`
  - 비로그인 → 401
  - rate limit 초과 → 429
- **`visibility-toggle.int.spec.ts`**:
  - OWNER PRIVATE → PUBLIC 성공 (category + description 제공)
  - PUBLIC 전환 시 category 누락 → 400 `WORKSPACE_CATEGORY_REQUIRED`
  - PUBLIC 전환 시 description 누락 → 400
  - ADMIN 시도 → 403 (030 BLOCKER-1 invariant 유지)
  - rate limit 초과 → 429

### D. D-4 + D-5 — 검색 description 확장 + sort tie-break

- 030 의 `discovery.service.ts` 쿼리:
  - 현재 `name ILIKE :q`
  - 변경 → `(name ILIKE :q OR description ILIKE :q)`
  - `q` 가 비어있으면 둘 다 적용 안 함 (전체 반환)
- 정렬 `ORDER BY member_count DESC, last_activity_at DESC NULLS LAST, id ASC`
  - tie-break `id` 가 추가되면 cursor 가 deterministic
- pg_trgm GIN 인덱스:
  - 015 가 message FTS 에 `pg_trgm` 도입함 (확장 이미 활성)
  - workspace 에는 인덱스 없을 가능성 → 새 partial index:
    ```
    CREATE INDEX CONCURRENTLY workspaces_discover_trgm
      ON workspaces USING gin ((name || ' ' || coalesce(description, '')) gin_trgm_ops)
      WHERE visibility = 'PUBLIC';
    ```
  - migration: 020 deploy-hook SQL 패턴 (CONCURRENTLY 라 transaction
    밖)
- EXPLAIN 캡처: PR.md 에 검색 query 의 plan 첨부 (GIN 사용
  확인)
- `discovery-list.int.spec.ts` 에 description 매칭 케이스 +
  tie-break deterministic 케이스 포함

### E. develop → main auto-promote + Pane 1 auto-forward (9th)

표준 flow.

## Scope (OUT)

- F-2 Friends / F-3 Home=DMs / Voice / Loki / PITR
- 승인 기반 참가 / 복수 카테고리 / 추천 알고리즘 (030 OUT 유지)
- Workspace settings 의 다른 영역 (invite 관리 / member 관리 /
  channel 권한 등) — visibility 만
- 화면 디자인 변경 (DS untouched)
- mecab-ko 기반 정확 검색

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- 3 int specs 전부 green on GHA:
  - `discovery-list.int.spec.ts`
  - `workspace-join.int.spec.ts`
  - `visibility-toggle.int.spec.ts`
- 두 endpoint 의 rate limit int 케이스 (429) 포함 + green
- E2E `workspace-visibility-toggle.e2e.ts` green:
  - OWNER → PRIVATE/PUBLIC 양방향 전환 OK
  - ADMIN → settings page 접근 OK 이지만 입력 disabled, 저장
    시도 시 403 (혹은 UI 가 막음)
  - PUBLIC 전환 시 category/description 공란 → submit 비활성화
- Workspace settings route 에서 다음 3 필드 DOM 존재 (data-testid
  기반 grep, 030 D 와 동일 명명):
  - `ws-visibility-public`
  - `ws-category`
  - `ws-description`
- `EXPLAIN GET /workspaces/discover?q=foo` → GIN index scan (PR.md
  첨부)
- Sort tie-break 검증: 동일 `(member_count, last_activity_at)`
  rows 가 cursor 페이지 사이에 정확히 한 번만 등장
- Description ILIKE 검증: description 만 매칭하는 row 가 결과에
  포함
- 030 의 5 deferred 항목 전부 closed (FINAL REPORT 표로 확인)
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched
- 3 artefacts: `031-*.md`, `031-*.PR.md`, `031-*.review.md`
- 1 eval 신규: `evals/tasks/042-workspace-discovery-follow.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` (path `/volume2/dockers/qufox-deploy/.deploy/`)
  last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 9번째**
- FINAL REPORT 자동 출력, 포함 항목:
  - develop/main SHA + exitCode + /readyz + idle + wall
  - **030 deferred 5건 closed 표** (D-1/D-2/D-3/D-4/D-5 각 status)
  - Settings UI grep 증거 (3 필드 data-testid)
  - Rate limit 429 응답 실전 증거 (curl 결과 또는 int spec 출력)
  - EXPLAIN 캡처 결과
  - Deferred TODO(task-031-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 030 + 030-follow merged + deployed (`cc29239` main)
- 030 의 `Workspace.visibility` / `category` / `description` 컬럼
  존재 + 030 API endpoints 활성
- 030-D 의 CreateWorkspacePage 3 필드 패턴 (data-testid `ws-*`)
- `SettingsOverlay` primitive (012 + 018) 재사용 가능
- 005 의 Redis sliding window rate limit 패턴 활성
- 015 의 `pg_trgm` extension 활성 (workspace 에는 인덱스 없음
  추정)

## Design Decisions

### Settings UI 는 기존 SettingsOverlay 재사용

012 channel-settings + 018 SettingsOverlay primitive 가 이미
정착. 동일 layout 으로 workspace settings 도 만들면 사용자
학습 비용 0. 새 design pattern 도입은 over-scope.

### Rate limit 은 005 패턴 그대로

011 / 013 / 015 / 016 / 027 모두 같은 데코레이터 + Redis
window. workspace-join 과 visibility-toggle 도 동일 pattern.

### Workspace 별 trgm 인덱스 신규 추가

015 의 message trgm 인덱스는 messages 테이블 전용. workspace
검색은 별도 인덱스 필요. partial (`WHERE visibility='PUBLIC'`)
로 PRIVATE 데이터 인덱싱 비용 회피. CONCURRENTLY 로 lock 회피
(020 의 deploy-hook SQL 패턴 재사용).

### Sort tie-break 은 `id ASC`

cursor pagination 안정성. created_at 도 가능하지만 id 가
deterministic + 인덱싱 자연.

### Description 까지 검색 확장

030 의 OUT 은 "FTS" 였고 ILIKE substring 은 OUT 항목 아님.
description 까지 확장은 사용자 검색 의도와 자연스러움
(이름 + 설명 둘 다 매칭).

### ADMIN 은 settings page read-only

030 reviewer BLOCKER-1 은 ADMIN visibility flip 차단. UI 도
그 invariant 를 표현 — ADMIN 이 페이지 자체엔 들어올 수 있게
하되 입력 disabled. 완전 숨김보다 "OWNER 만 변경 가능" 안내가
역할 모델 명확.

## Non-goals

- Workspace settings 의 다른 탭 (member / invite / channels)
- Discovery 의 추천 / trending 섹션
- mecab-ko 기반 검색
- Workspace icon 업로드 (017 후속)
- Workspace 영구 삭제

## Risks

- **`SettingsOverlay` 가 channel 전용 가정으로 작성됐을 가능성**
  — UNDERSTAND 에서 컴포넌트 generic 한지 확인. 아니면 props
  소폭 확장 (props on save callback + props on cancel callback).
- **`pg_trgm` 가 workspace 컬럼에 적용 시 dataset 작아 ILIKE
  Seq Scan 이 더 빠를 수 있음** — 베타 단계 workspace 수십 ~
  수백 개. 인덱스 효과 작음. 그래도 큰 비용 아니라 미래
  확장성 위해 추가. EXPLAIN 으로 확인하고 인덱스가 사용 안 되면
  주석으로 기록.
- **Rate limit windowSec / limit 값**: join 5/min 이 진짜
  사용자에게 너무 빡빡할 수도. mitigation: env 로 override
  가능하게 + reviewer 피드백 받아 조정.
- **Workspace settings route 가 이미 존재할 수도** — UNDERSTAND
  에서 grep 해서 확인. 있으면 그 route 의 panel 에 "공개 설정"
  탭 추가; 없으면 신규.
- **모바일 viewport 에서 settings UI 동작** — 024 모바일 shell
  의 SettingsOverlay 가 모바일에서 어떻게 보이는지 확인 (Bottom
  sheet 인지 fullscreen 인지). 026 ScreenChannel mockup 의
  settings 참조.

## Progress Log

_Implementer 채움_

- [ ] UNDERSTAND (workspace settings route 존재 여부, SettingsOverlay
      generic 정도, 030 의 visibility endpoint 정확한 path,
      pg_trgm 인덱스 현황, 005 rate limit decorator 시그니처)
- [ ] PLAN approved
- [ ] SCAFFOLD (Settings page skeleton, rate limit decorator
      적용, 3 int specs red, EXPLAIN baseline 캡처)
- [ ] IMPLEMENT (A → B → C → D)
- [ ] VERIFY (`pnpm verify` + GHA int + e2e green)
- [ ] OBSERVE (3 필드 data-testid grep, rate limit 429 curl,
      EXPLAIN GIN 사용 확인)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT auto-printed + **pane 1 auto-forwarded 9th**
      with 030 deferred 5건 closed 표)
