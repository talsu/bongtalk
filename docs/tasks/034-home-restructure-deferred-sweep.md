# Task 034 — 033 Deferred Sweep: Channel.workspaceId nullability + 모바일 Home/Overlay + Activity standalone → main deploy

## Context

033 가 데스크톱 Home + DM + tabbar 3탭 + BottomBar dropdown 까지
core 를 ship 했지만 4 건이 deferred:

- **A 미완**: `Channel.workspaceId` nullable migration 이 10+
  services (010 unread / 011 mention / 014 thread / 015 search /
  020 health / 026 Activity / 027 DM / 030 Discovery / 기타) 에
  cascading 영향이라 보류. 현재 Global DM 채널은 어떤 임시
  workspace ID 로 작동 중 (sentinel 또는 personal workspace
  추정 — UNDERSTAND 첫 단계에서 확인)
- **E 미완**: 모바일 Home screen split (왼쪽 workspace+DM rail
  - 오른쪽 channel/friend list) — 모바일 Home 화면 자체가
    033 변경 미반영
- **F 미완**: 모바일 overlay 채팅 슬라이드
- **I 미완**: Activity standalone reshape audit (이미 standalone
  일 가능성 있으나 검증 안 됨)

034 는 이 4 건을 한 sweep 으로 마무리.

## Scope (IN) — 6 chunks

### A. Channel.workspaceId nullability cascade

**Step 1 — 현재 sentinel/임시 동작 audit**

UNDERSTAND 단계에서 확인:

- 033 의 `createOrGetGlobal` 이 `Channel` insert 시 workspaceId
  에 어떤 값을 넣고 있는지 (zero UUID? user 별 personal
  workspace 자동 생성? 아무 workspace?)
- 그 값이 다른 service 의 workspace-scoped 쿼리에 어떻게
  영향?

**Step 2 — Schema migration**

- Prisma migration:
  - `Channel.workspaceId` 를 nullable 로 변경
  - DB CHECK constraint 추가:
    `CHECK ((type = 'DIRECT') OR (workspaceId IS NOT NULL))` —
    DIRECT 만 NULL 허용, 나머지 (TEXT/VOICE/...) 는 필수
  - 기존 sentinel/임시 값으로 채워진 DM channel row 들의 데이터
    정합성 처리:
    - sentinel UUID 사용 중이었다면 → 모두 NULL 로 backfill
    - Personal workspace 자동 생성 패턴 사용 중이었다면 → 그
      workspace 와 DM 채널의 관계 정리 (가능하면 DM 만 NULL,
      personal workspace 는 archive 또는 유지)
- Reversible (down: NULL → sentinel 변환 + NOT NULL 복원)

**Step 3 — Cascading service audit & fix (우선순위 순)**

nullability 변경 시 NULL 처리 추가 필요 site:

| 우선순위 | Service                       | NULL 처리 정책                                                                                        |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1        | **010 UnreadService**         | Global DM 도 unread 카운트 포함; workspaceId 별 aggregate 시 NULL 그룹은 "DMs" 별도로 처리하거나 통합 |
| 2        | **011 Mention dispatcher**    | DM 에서 멘션은 027 의 dedup 정책 (DIRECT 통합) 유지                                                   |
| 3        | **026 Activity inbox**        | UNION 쿼리에 NULL workspaceId 도 포함, source 분류 정확                                               |
| 4        | **014 Thread service**        | DM 에서 thread 비활성 (033-D 명시); rawList 등 workspace 필터에 NULL 케이스 추가                      |
| 5        | **015 FTS search**            | DM 메시지도 검색 결과에 포함; workspaceId 필터 NULL 처리                                              |
| 6        | **020 OutboxHealthIndicator** | 영향 적음 — outbox event 자체가 채널 무관                                                             |
| 7        | **027 DirectMessageService**  | createOrGet 가 createOrGetGlobal 과 통합 (workspaceId optional)                                       |
| 8        | **030 Discovery**             | workspace 만 다루므로 channel 무관, 영향 없음                                                         |

각 service 별 unit / int spec 갱신:

- `unread-global-dm.int.spec.ts` (NULL workspaceId 채널 unread)
- `mention-in-dm.int.spec.ts`
- `activity-dm-source.int.spec.ts`
- `search-dm-messages.int.spec.ts`
- `thread-dm-rejected.int.spec.ts` (DM 채널에선 thread 거부)

**Step 4 — Backward-compat audit**

- 027 의 `/me/workspaces/:wsId/dms` 가 여전히 workspace-scoped
  channel 만 반환하는지 (deprecated 동작)
- Global DM 이 workspace-scoped 응답에 들어가지 않는지

### E. 모바일 Home Screen Split

`MobileHome.tsx` 신규 또는 기존 `Shell` 의 모바일 분기 확장:

- Tabbar **Home 탭** 진입 시:
  - `qf-m-screen` 안 grid layout 두 영역
    - **왼쪽 narrow column** (~76px) — DM 포함 workspace rail:
      - 최상단: DM 아이콘 (`qf-m-server-btn` + Icon `message`)
      - workspace 아이콘들
      - `+` 생성, `🔍` 찾기
      - 활성 항목 highlight (`qf-m-server-btn--active` 또는
        DS 변형)
    - **오른쪽 wider column** — 활성 항목 컨텍스트:
      - DM 활성 → 친구 목록 (qf-m-row per friend, status 정렬,
        "친구" 메뉴 row 위)
      - workspace 활성 → 채널 목록 (qf-m-row per channel, 카테고리
        헤더)
- DS 활용:
  - `qf-m-rail` (mini server rail) 이 mobile.css 에 있는지 확인
    → 있으면 사용; 없으면 `qf-serverlist` 의 mobile-friendly
    축소 변형 또는 신규 `qf-m-server-btn` 클래스 한 줄 mobile.css
    에 추가 (DS source of truth 위배 — 가능하면 기존 클래스
    조합으로 해결)
  - 채널 list / 친구 list 는 기존 `qf-m-row` 재사용
- URL 처리:
  - DM 활성: `/dm`
  - Workspace 활성: `/w/:slug`
  - active state 는 useUI store 또는 URL 기반 derive
- E2E `home-mobile-base.mobile.e2e.ts` (양 영역 DOM 존재 + DM/
  workspace 전환 시 오른쪽 컨텍스트 변경)

### F. 모바일 Overlay 채팅 슬라이드

- 채널 row (`qf-m-row` for channel) 또는 친구 row (`qf-m-row`
  for friend) 클릭 시:
  - 신규 `qf-m-screen` overlay 가 z-index 높게 마운트
  - CSS:
    ```css
    .qf-m-overlay {
      position: fixed;
      inset: 0;
      transform: translateX(100%);
      transition: transform var(--dur-fast) var(--ease-out);
    }
    .qf-m-overlay--open {
      transform: translateX(0);
    }
    ```
  - mount 후 next frame 에서 `--open` class 적용 → 슬라이드 in
- Overlay 내용: 기존 모바일 채팅 화면 (027/024 의 MobileMessages
  / DM chat) 그대로 + 좌측 상단 `qf-m-topbar__back` 추가
- ← 클릭 또는 browser back:
  - `--open` class 제거 → 슬라이드 out
  - `transitionend` 이벤트로 unmount + URL 갱신
- URL 매핑:
  - `/dm` ↔ `/dm/:friendId`
  - `/w/:slug` ↔ `/w/:slug/c/:ch`
- `history.pushState` 로 overlay open 시 entry 추가 → browser
  back 으로 자연 close
- underneath Home 은 unmount 안 됨 (overlay 가 위에 덮이는
  z-index 만 조정)
- E2E `home-mobile-overlay.mobile.e2e.ts` (친구 또는 채널 선택
  → overlay 슬라이드 → ← back → close 후 Home DOM 그대로 유지
  - history.pushState 검증)

### I. Activity Standalone Audit & Reshape

- 026 데스크톱 `/activity` 가 이미 standalone (channel-list
  영역 차지 안 함, main 영역 전체) 인지 audit:
  - DOM 구조 확인 — `qf-channellist` 가 표시되는지
  - 만약 inline embed (workspace shell 의 right panel) 였다면
    standalone 으로 reshape:
    - server rail 은 보임
    - channel-list column 자체가 사라지고 main 영역 100%
      Activity 페이지 차지
- E2E `activity-fullscreen-page.e2e.ts` (Activity 가 channel-list
  표시 안 함, main 영역 전체 차지)
- 모바일 `/activity` 도 동일 검증 (Tabbar Activity 탭 진입 시
  qf-m-screen 전체)

### J. E2E + 회귀

신규:

- `unread-global-dm.int.spec.ts`
- `mention-in-dm.int.spec.ts`
- `activity-dm-source.int.spec.ts`
- `search-dm-messages.int.spec.ts`
- `thread-dm-rejected.int.spec.ts`
- `home-mobile-base.mobile.e2e.ts`
- `home-mobile-overlay.mobile.e2e.ts`
- `activity-fullscreen-page.e2e.ts`

기존 회귀:

- 010/011/014/015/020/026/027 의 spec 들이 nullable 변경 후에도
  green 유지

### K. develop → main auto-promote + Pane 1 auto-forward 12th

표준 flow.

## Scope (OUT)

- 027 의 `/me/workspaces/:wsId/dms` API 완전 삭제 (deprecated 만)
- 새 feature (Voice / Group DM / Custom emoji / Loki / PITR /
  mecab-ko)
- 친구 추천 / friend graph 분석
- DS mobile.css 신규 클래스 추가 — 가능하면 기존 클래스 조합으로
  해결. 불가피한 경우만 추가하고 사유 기록
- Activity 페이지 자체의 새 기능 (필터 / 정렬 / 알림)
- 기존 sentinel workspace data 의 long-term archive

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- Prisma migration reversible (`make_channel_workspace_id_nullable.sql`
  - CHECK constraint)
- 기존 DM channel row 의 workspaceId 가 NULL 로 backfill 됐는지
  검증 (`SELECT count(*) FROM channels WHERE type='DIRECT' AND workspaceId IS NULL` > 0)
- `pnpm --filter @qufox/api test:int` green:
  - `unread-global-dm.int.spec.ts`
  - `mention-in-dm.int.spec.ts`
  - `activity-dm-source.int.spec.ts`
  - `search-dm-messages.int.spec.ts`
  - `thread-dm-rejected.int.spec.ts`
  - 010/011/014/015/020/026/027 기존 specs 회귀 없음
- `pnpm --filter @qufox/web test:e2e` green, 신규 3 specs:
  - `home-mobile-base.mobile.e2e.ts`
  - `home-mobile-overlay.mobile.e2e.ts`
  - `activity-fullscreen-page.e2e.ts`
- 모바일 Home screen 양 영역 DOM 존재 + DM/workspace 전환 정상
- 모바일 overlay 슬라이드 in/out CSS transform 동작 (animation
  대신 final state 검증)
- `/activity` 가 channel-list 표시 안 함 (DOM 검증)
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched (또는 mobile.css 변경 시 사유 + 새 qf-m-\* 클래스 1-2개
  내 + 사용자 명시 검토)
- qf-m-\* 사용 카운트 증가 (250+ → 280+ 예상)
- 3 artefacts: `034-*.md`, `034-*.PR.md`, `034-*.review.md`
- 1 eval: `evals/tasks/045-home-restructure-deferred.yaml`
- Reviewer subagent 실제 스폰
- develop → main auto-promote via webhook
- audit.jsonl exitCode=0 + /readyz 200 + idle 30s
- **Pane 1 auto-forward 12번째**
- FINAL REPORT 자동 출력, 포함:
  - develop/main SHA + exitCode + /readyz + idle + wall
  - 청크별 A/E/F/I/J/K 산출물 표
  - **033 deferred 4건 closed 표** (A/E/F/I status)
  - nullable migration sentinel data 정리 결과 (row count)
  - 영향 services 별 NULL 처리 정책 매트릭스
  - 모바일 Home screen + overlay 동작 캡처 (스크린샷 또는 영상)
  - Deferred TODO(task-034-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 033 merged + deployed (`bb0df73` main)
- 033 의 데스크톱 DmShell + 모바일 tabbar 3탭 + BottomBar
  dropdown Activity entry 활성
- 033 의 임시 sentinel/personal workspace 동작 (UNDERSTAND 에서
  파악)
- 010 unread / 011 mention / 014 thread / 015 search / 026
  Activity 의 channel-related query 위치 (audit 대상)
- DS `qf-m-screen`, `qf-m-rail` (있으면), `qf-m-server-btn`
  (있으면), `qf-m-row` 활용 가능

## Design Decisions

### Cascading audit 우선순위

사용자 가시 영향 큰 service 부터: unread (사이드바 숫자) →
mention (알림 toast) → Activity (inbox) → thread (DM 에선 비활성) →
search (DM 검색).

### CSS-only overlay 애니메이션

framer-motion 추가는 번들 사이즈 증가. CSS transform + transition
이 60fps 보장 가능. tokens 의 `--dur-fast` + `--ease-out` 재사용.

### 모바일 Home 의 좌측 rail width 76px

024 데스크톱 server rail 과 비슷한 비율. 6열 정도가 화면 폭의
20% 정도라 시각적 균형. 정확값은 implementer 가 mockup 과
비교해서 finalize.

### Activity audit 가 standalone 확인뿐일 수도

026 가 이미 정확히 standalone 으로 만들어졌다면 I 는 audit

- E2E spec 추가만 하면 되어 적은 비용. 만약 inline embed 였다면
  reshape 가 큰 작업.

### Sentinel data 정리

033 의 임시 동작이 어떤 sentinel 값 사용했냐에 따라 다름:

- Zero UUID → 모두 NULL backfill 후 sentinel row 가 있다면 삭제
- Personal workspace 자동 생성 → DM 만 NULL 로 풀고 personal
  workspace 는 archive/유지
- 기존 workspace-scoped DM (027) → workspaceId 그대로 유지 (NULL
  변환 X)

### NULL 처리는 service 별 explicit 분기

암묵적 `IS NOT NULL` 의존을 explicit 분기로 변경해서 future
nullable column 추가 시 같은 cascade 재발 방지.

## Non-goals

- DS mobile.css 신규 클래스 추가 (필요 시 1-2 개만)
- Voice / Group DM / Custom emoji / mecab-ko / Loki / PITR
- 027 deprecated API 완전 삭제 (다음 cleanup task)
- Friend graph 분석 / 추천
- Activity 페이지의 새 필터 / 정렬

## Risks

- **Sentinel data 정체 모름**: 033 의 createOrGetGlobal 실제 구현
  read 후 결정. 잘못된 정리 → DM 채널 데이터 손실 위험. UNDERSTAND
  에서 충분한 검증 필수.
- **10+ services cascade 가 예상보다 더 많을 수 있음**: 다른
  module 에서 channel.workspaceId 직접 사용하는 site 발견 가능.
  grep 으로 전수 audit + each fix.
- **모바일 Home screen E e2e 가 viewport assertion 어려움**:
  376px 모바일 viewport 에서 layout 가 정확한지 검증. dimension
  변동 허용 범위 설정.
- **Overlay back 처리 vs Tab 전환 race**: 사용자가 overlay 안에서
  tabbar 다른 탭 누르면 → tab 전환과 overlay close 동시 발생.
  state 정리 순서 명확화.
- **iOS Safari 의 visualViewport + transform**: 키보드 올라올 때
  overlay translateX 와 visualViewport offset 충돌 가능. 024 의
  keyboard dodge 패턴과 호환 검증.
- **027 의 deprecated API 호출이 sentinel 동작 의존**: 027 호출
  site 가 sentinel workspaceId 전제로 작성됐다면 NULL 변경 후
  500 가능. log/metric 으로 호출 횟수 확인 + 안전 처리.
- **030 Discovery 가 NULL workspaceId channel 노출 우려**:
  Discovery 는 Workspace 만 검색하므로 channel 영향 X. 다만
  cross-checking 필요.

## Progress Log

_Implementer 채움_

- [ ] UNDERSTAND (033 의 sentinel/personal workspace 실제 동작
      audit, 010/011/014/015/020/026/027 의 channel.workspaceId
      쿼리 site grep, qf-m-rail / qf-m-server-btn DS 존재 여부,
      026 데스크톱 /activity layout 확인)
- [ ] PLAN approved (sentinel 정리 정책 + cascade fix 우선순위
      finalize)
- [ ] SCAFFOLD (nullable migration red, MobileHome split skeleton,
      overlay primitive stub, Activity layout 변경 분기 마련)
- [ ] IMPLEMENT (A → I → E → F → J)
- [ ] VERIFY (`pnpm verify` + GHA int + e2e green + 모바일
      viewport 화면 캡처)
- [ ] OBSERVE (sentinel data row count, cascade fix 매트릭스,
      모바일 Home/overlay screenshot, Activity standalone 검증)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT auto-printed + **pane 1 auto-forwarded 12th**)
