# Task 041 — 040 follow MED+ 일괄 sweep → main deploy

## Context

Task 040 (PL4 Channels + DMs, main=`037c71d`) 종료 시 11건의 MED+ TODO
가 이월됐다. 큰 단위 두 건 (`lighthouse-ci` / `virtualization`) 은
별도 task 로 분리하고, 나머지 9건을 한 sweep 으로 청소해 다음
PL iteration (042) 의 출발선을 깔끔하게 만든다.

11건 분류:

**Sweep 대상 (이번 task, 9건)**

- review H2 — banner-dom-render-test
- review M1 — banner-topbar-offset
- review M2 — send-fail-mutation-test
- review M3 — clamp-race
- review M4 — friends-input-label
- R1 — visual-inline-px-jsstrings
- R2 — a11y-input-labels-out-of-scope
- R3 — error-states-edit-delete-skeleton
- R7 DM-1 — dm-workspaceless-presence

**별도 task 분리 (이번 task OUT)**

- task-040-follow-lighthouse-ci → 042 후보 (R8 Performance 실측 인프라)
- task-040-follow-virtualization → 별도 (메시지 list react-virtual, 1일)

## Scope (IN) — 4 chunks

### A. UX 보강 (3건)

**A-1. banner-topbar-offset** (review M1)

- 증상: ConnectionBanner (R3 신규) 가 desktop 의 sticky topbar
  영역과 겹쳐 첫 메시지 / 채널 헤더 가림
- 수정:
  - Banner 컨테이너에 `top` offset = topbar 높이 + safe-area inset
  - 모바일 viewport 의 status-bar 고려
  - Banner 가 dismiss 됐을 때 main content 의 상단 padding 복원
- 위치: `apps/web/src/features/connection/ConnectionBanner.tsx`
- 검증: 데스크톱 + 모바일 viewport 에서 banner 표시 시 topbar /
  메시지 영역 겹침 0px

**A-2. error-states-edit-delete-skeleton** (R3)

- 증상: 메시지 edit / delete 동작 시 skeleton 부재 → 응답 지연
  중 사용자 피드백 누락
- 수정:
  - Edit 진행 중 메시지 row 에 skeleton overlay (전송 시 동일 패턴)
  - Delete 진행 중 row opacity 0.5 + spinner
  - 실패 시 toast push + 원상복귀
- 위치: `apps/web/src/features/messages/MessageRow.tsx` (또는 동등)
- 검증: 페이크 latency 1s 환경에서 edit/delete 사용 시 skeleton
  표시 + 실패 retry 동작

**A-3. dm-workspaceless-presence** (R7 DM-1)

- 증상: DM list 에서 상대방 online/offline/away 표시 부재
- 설계:
  - 011 presence Redis 캐시 + WS subscribe 재사용
  - DM list row 에 status dot (qf-status-dot, 기존 컴포넌트 사용)
  - Status: online (green) / away (yellow) / offline (gray)
- 위치: `apps/web/src/shell/DmShell.tsx` + `MobileDmList.tsx`
- 검증: 두 사용자 동시 로그인 → DM list 에 상대 status 즉시 표시
  - 한쪽 로그아웃 → 다른쪽 list 에 offline 으로 갱신

### B. 회귀 spec 보강 (3건)

**B-1. banner-dom-render-test** (review H2)

- e2e: `apps/web/e2e/connection/banner-dom-render.e2e.ts`
- 시나리오:
  - 정상 상태: banner 미마운트 (selector 부재)
  - WS disconnect 시뮬: banner 마운트 + "연결이 끊겼습니다" 텍스트
  - 재연결: banner 사라짐 (transition 끝나고)
  - 동일한 banner 가 동시에 두 번 마운트 안 됨 (single-mount 검증)

**B-2. send-fail-mutation-test** (review M2)

- unit/integration: `apps/web/src/features/messages/useSendMessage.spec.ts`
- 시나리오:
  - mutation `onError` 호출 시 toast push 함수가 호출됐는지 mock 으로
    검증
  - error code 별 메시지 분기 (network / 401 / 5xx)
- 기존 `sendFailureToast.contract.spec.ts` 와 분리 — mutation 레벨 검증

**B-3. clamp-race** (review M3)

- unit: `apps/web/src/features/messages/clampAttachments.race.spec.ts`
- 시나리오:
  - 동시 paste + drag-drop 시뮬 — server cap = 10 환경에서 9 + 3 추가
    → 결과는 10 개로 clamp + 12-10=2 dropped
  - 두 호출이 같은 attachment array 를 mutate 하지 않음 (immutable
    return) 검증
- 기존 `clampAttachments.spec.ts` 의 7 boundary 외 추가

### C. A11y 누락 보강 (2건)

**C-1. a11y-input-labels-out-of-scope** (R2)

- 040 R2 에서 채널/DM critical-path 9 inputs 만 처리
- 이번엔 settings / discover / signup 의 9 inputs 추가:
  - `WorkspaceSettings`: 이름 / slug / description / category 4개
  - `DiscoverFilter`: 검색 input 1개
  - `SignupForm`: email / password / displayName 3개
  - `WorkspaceCreateDialog`: 이미 R2 cover 됐는지 grep — 없으면 추가
- 적용: aria-label / `<label htmlFor>` / wrap `<label>` 중 하나
- 검증: `apps/web/src/a11y/input-label-guard.spec.ts` 의 audit 범위
  확장 → 새 inputs cover

**C-2. friends-input-label** (review M4)

- Friends search input 의 aria-label 또는 `<label>`
- 위치: `apps/web/src/features/friends/FriendsList.tsx` (또는 동등)
- C-1 의 input-label-guard 에 자동 cover

### D. Visual cleanup — visual-inline-px-jsstrings (R1)

- JS 문자열 (template literal / inline style object) 에 박힌 raw
  px 값 grep → DS spacing token 또는 page-scoped CSS class 로 교체
- 대상 grep:
  ```
  grep -rn "['\"][0-9]\+px['\"]" apps/web/src
  grep -rn "style={{.*[0-9]\+px" apps/web/src
  ```
- 처리 우선순위:
  - 채널/DM 흐름 (이미 R6/R7 cover) 다음으로 settings / discover /
    workspace-create / mobile shell
- 변환 예시: `'16px'` → CSS class `qf-spacing-md` 또는 `var(--qf-space-4)` reference
- DS 4파일 untouched 유지 — page-scoped CSS file 또는 component-local
  CSS module 만
- 변환 cap: 30건 (초과 분 follow-up)

### E. develop → main auto-promote + Pane 1 auto-forward 19번째

표준 flow.

## Scope (OUT)

- task-040-follow-lighthouse-ci (042 별도)
- task-040-follow-virtualization (별도, 1일 단위)
- 새 feature
- 새 dimension audit (PL5 는 042 이후)
- DS 4파일 수정
- A11y full re-audit (이번엔 누락분만)
- Performance 측정 (lighthouse 인프라 부재 그대로)
- Mobile gesture / IME 신규 audit (040 R5 종료)
- 새 컴포넌트 / 새 view

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- **A 검증**:
  - A-1: banner overlap 0px (e2e screenshot diff 또는 boundingBox 확인)
  - A-2: edit/delete skeleton 표시 e2e
  - A-3: DM list 의 presence dot 동작 e2e (두 context)
- **B 검증**:
  - B-1: e2e green (3 시나리오: 정상/disconnect/reconnect)
  - B-2: spec green (mock toast push 호출 횟수 검증)
  - B-3: spec green (immutable + 12→10 clamp)
- **C 검증**:
  - C-1: input-label-guard 가 settings/discover/signup 9 inputs cover
  - C-2: Friends input label cover
  - 누락 inputs grep → 0 hits 또는 명시적 이월
- **D 검증**:
  - 변환 건수 10 이상 (cap 30 이내)
  - DS 4파일 git diff 0
  - `grep` 결과: 변환 후 raw px 잔존 < 50% (baseline 대비)
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched (`git diff` 0)
- 3 artefacts: `041-*.md`, `041-*.PR.md`, `041-*.review.md`
- 1 eval: `evals/tasks/052-040-follow-med-sweep.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` 위치는 `/volume2/dockers/qufox-deploy/.deploy/audit.jsonl`
  (memory: `reference_deploy_audit_location.md`) — last entry `exitCode=0`
  - sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 19번째**
- FINAL REPORT 자동 출력, 포함:
  - develop/main SHA + exitCode + /readyz + idle + wall clock
  - 청크 A~D 산출물 표
  - 11 follow → 처리/이월 매핑 표 (sweep 9건 처리 + 2건 분리)
  - banner offset 데스크톱+모바일 capture
  - DM presence dot 두 context capture
  - input-label-guard 확장 결과 (cover된 input 수)
  - inline-px 변환 grep 전후 수치
  - 추가/보강 spec 테이블
  - Deferred TODO(task-041-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 040 merged + deployed (`037c71d` main)
- 11 ConnectionBanner / sendFailureToast / clampAttachments 기반
  컴포넌트 운영 중
- 011 Presence Redis 캐시 + WS subscribe 동작
- 040 의 input-label-guard 정적 audit harness
- 026/028 polish harness (회귀 guard)

## Design Decisions

### Lighthouse / virtualization 분리

각각 독립 단위:

- Lighthouse CI: NAS 에 lhci 컨테이너 + 측정 surface + budget 게이트
  → 042 후보 (반나절~1일)
- Virtualization: 메시지 list react-virtual 도입 → 단일 변경이지만
  scroll behavior + retain-on-resize + WS append 등 검증 부피 큼

이번 sweep 에 묶으면 4-chunk 가 6-chunk 가 되고 verify cycle 길어짐.

### A-3 DM presence 의 폭

011 의 presence 인프라가 있어 새 endpoint 불필요. 단 DM list 에
status 표시는 처음. 기존 channel member sidebar 의 dot 컴포넌트
재사용. 신규 컴포넌트 추가가 아닌 기존 컴포넌트 호출 위치 확장.

### Banner offset 의 mobile 처리

035 의 모바일 overlay 패턴 따라 safe-area-inset-top 사용. address-bar
collapse 시점 맞춰 transition.

### Edit/delete skeleton vs optimistic update

Optimistic 이 UX 우수하지만 rollback 복잡. 이번엔 skeleton + 실패
시 toast 만. Optimistic 은 follow-up 이월.

### Inline-px cap 30

대량 일괄 변경은 회귀 risk. 30건 까지만 + raw px 잔존 baseline 의
< 50% 가 실용 목표. 100% 제거는 후속 task.

### Input-label-guard 확장 vs 신규 audit

040 R2 의 정적 audit harness 가 이미 존재. 동일 audit 의 cover 범위만
넓힌다. 새 audit 도구 도입 (axe-core e2e 통합 등) 은 OUT.

### 회귀 spec 우선

이번 sweep 의 절반 (B 청크 3건) 이 review 의 H/M 응답 — spec 누락
보강. 코드 변경 < spec 추가 비율 60% 이상 목표.

## Non-goals

- Lighthouse CI 인프라 / Performance 실측
- Virtualization
- 새 feature
- DS 재디자인
- A11y 전체 재 audit
- 새 dimension audit
- 새 컴포넌트
- BE 도메인 신규 endpoint
- Optimistic update 도입
- 모든 raw px 제거 (cap 30)

## Risks

- **DM presence dot 가 list re-render 폭증 일으킴**: WS event 마다
  list query invalidate 하면 N+1 paint. presence 만 별도 store +
  selective render
- **Banner offset 변경이 모바일 overlay 깸**: 035 의 overlay 와
  z-index 순서 충돌 가능성. 둘 다 표시되는 시나리오 수동 테스트
- **Edit/delete skeleton 이 long-running 메시지 포기 못 하게 함**:
  취소 버튼 또는 5s timeout 고려 (이번엔 timeout 만)
- **Inline-px 변환이 layout shift 일으킴**: spacing token 이 정확히
  같은 값일 때만 안전. 다르면 px 그대로 두고 follow-up
- **clamp-race spec 의 동시성 시뮬**: 진짜 동시성 어려움 — Promise.all
  로 시뮬 + immutable return 검증으로 대체
- **입력 label guard 확장이 false positive**: 기존 audit 가 검출
  못한 패턴 (예: shadcn FormField wrapper 안 input) 이 있을 수
  있음. 발견 시 audit 룰 자체 보강
- **deploy audit 경로 잘못 보기**: 메모리에 박혔지만 한 번 더
  명시. `/volume2/dockers/qufox-deploy/.deploy/audit.jsonl` 사용

## Progress Log

_Implementer 채움_

- [ ] UNDERSTAND (040 review.md 의 H/M 항목 전수, 011 presence
      WS event shape, ConnectionBanner 위치 + 마운트, 040 의
      input-label-guard.spec.ts, MessageRow 의 edit/delete UI,
      inline-px grep baseline 수)
- [ ] PLAN approved
- [ ] SCAFFOLD (각 chunk 의 stub spec red, banner offset CSS stub,
      DM presence dot wiring stub)
- [ ] IMPLEMENT (A → B → C → D)
- [ ] VERIFY (`pnpm verify` + 신규/보강 spec green + e2e green +
      DS diff 0 + inline-px 잔존 grep < 50% baseline)
- [ ] OBSERVE (11 follow 처리 매핑 표, banner offset capture,
      presence dot capture, label-guard cover 수, inline-px
      전후 수)
- [ ] REFACTOR
- [ ] REPORT (develop merge → main auto-promote via webhook →
      FINAL REPORT auto-printed + **pane 1 auto-forwarded 19th**)
