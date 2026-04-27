# Task 040 — Production Polish Loop (PL4) · Channels + DMs

## Context

Beta 진입 전 채널 + DM 기능을 **상용 app 수준** 으로 끌어올린다.
새 feature 없음. 기존 기능의 UX 어색함, 데스크톱/모바일 정합성,
accessibility, performance, error states, edge cases 를 자율
반복 round 로 수렴시킨다.

기존 polish loop (021 / 022 / 025 / 028) 의 round-기반 self-repeating
패턴을 8 dimension × ≤3 round = max 24 round 까지 확장. 사용자
개입 없이 각 round 가 다음 round 를 결정.

## Scope (IN) — 자율 반복

### 8 Dimensions

채널/DM critical path 에 직접 영향 주는 영역만:

1. **Channel messages** — composer 입력 / 메시지 list 렌더 /
   virtualization / scroll behavior / unread badge / typing indicator
   / mention / reaction / message hover actions
2. **DMs** — workspaceless flow (`/me/dms`) / presence indicator
   / 채널 list 정렬 + 미읽음 / history pagination / participant
   metadata
3. **모바일 viewport** — 375x667 (iPhone SE), 414x896 (iPhone XR /
   pixel-class), touch target ≥ 44px, swipe gesture, 한국어 IME,
   safe-area inset, address-bar collapse 동작
4. **Accessibility** — ARIA 속성 (role / label / live region) /
   focus order / 키보드 nav (Tab / Enter / Esc / arrow) / screen
   reader announcement
5. **Performance** — FCP / LCP / CLS (Lighthouse), scroll FPS
   (Performance API), WS reconnect time, 첫 메시지 paint 시간,
   bundle size delta
6. **Visual consistency** — DS tokens 사용 일관성 (raw hex / px
   금지), dark mode 정합 (있다면), 컴포넌트 변형 (button / input /
   modal) 일관성, spacing scale 준수
7. **Error / Empty / Loading states** — 네트워크 끊김 (offline
   banner) / 빈 채널 / 빈 DM list / message send 실패 retry /
   skeleton loader / 401 expiry / 5xx fallback
8. **Edge cases** — 매우 긴 메시지 (10k chars) / 한국어 IME 조합
   중 send / 다중 첨부 (max + 1) / `:emoji:` 패턴과 일반 텍스트
   충돌 / URL preview / 코드 블록 / mention not-found / 동일 채널
   다중 탭

### Round per dimension

각 round 는 다음 8 step 으로 진행:

1. **AUDIT** — 데스크톱 + 모바일 각 viewport 에서 dimension 의
   critical path 전수 확인. Playwright 시나리오 + 사용자 시뮬.
   결과는 `docs/tasks/040-round-N-<dim>.md` 에 기록.
2. **IDENTIFY** — issue 분류:
   - BLOCKER: 핵심 흐름 동작 안 함 / 데이터 손실 / 보안
   - HIGH: 명백한 UX 어색함 / 빈번 빈도 / 성능 저하
   - MED: 사용자 인지 가능하지만 critical 아님
   - LOW: cosmetic / theoretical
3. **FIX** — BLOCKER + HIGH 만 처리. 한 round 안에서 fix-forward
   직진. MED+ 는 TODO(task-040-follow-<dim>-<slug>) backlog.
4. **REGRESSION SPEC** — 각 fix 마다 e2e 또는 int spec 추가 (또는
   기존 spec 보강). 회귀 spec 없이 fix 만 하면 안 됨.
5. **VERIFY** — `pnpm verify` + 영향 spec green. 3회 연속 실패
   시 round 중단 + 가설 3개 + 사용자 질문.
6. **DECIDE** — 다음 round 필요 여부:
   - 이번 round 에서 BLOCKER + HIGH = 0 → 이전 round 도 0 이었으면
     dimension 완료. 아니면 한 번 더 audit 으로 확정 round 추가.
   - BLOCKER + HIGH > 0 → 다음 round 진행 (max 3 reached 면
     강제 종료, 미해결 issue 는 TODO(task-040-follow) 이월).
7. **DEVELOP MERGE** — round 단위 commit + develop merge (CI green
   조건). 컨텍스트 압축 발생해도 round 별로 resume 가능.
8. **PROGRESS LOG** — `040-round-N-<dim>.md` 갱신, dimension matrix
   에 round 결과 기록.

### Dimension 진행 순서

Dependency 가 적은 영역 → 위로 빌드되는 영역 순:

1. Visual consistency (DS 정합) — 다른 fix 의 시각 baseline
2. Accessibility — 구조 보강은 다른 fix 와 충돌 적음
3. Error / Empty / Loading states — UX critical 첫 인상
4. Edge cases — 발견 내용이 1-3 에 영향 가능
5. 모바일 viewport — 위 fix 들이 모바일에 어떻게 반영됐는지 점검
6. Channel messages — 핵심 흐름, 위 fix 누적 후 관통 audit
7. DMs — channel polish 의 변형 적용
8. Performance — 마지막. 모든 변경 후 baseline 측정 + budget 충족

### 수렴 종료 조건

- 같은 dimension 2 round 연속 0 BLOCKER + 0 HIGH → dimension 완료
- 모든 8 dimension 완료 → loop 종료
- 또는 누적 24 round 도달 → cap 종료

종료 후 develop → main auto-promote 1회 + 통합 FINAL REPORT.

### Pane 1 auto-forward — 18번째 (마지막만)

Round 별 mini-progress 는 pane 0 안에서만. 최종 통합 REPORT 만
pane 1 으로 forward.

## Scope (OUT)

- 새 feature (Voice / Group DMs / mecab-ko / Friends 확장)
- 아키텍처 / 도메인 모델 변경
- DS 4파일 (`tokens.css` / `components.css` / `mobile.css` / `icons.css`) 수정
- MED+ 의 일괄 해결 — TODO(task-040-follow-\*) backlog 로
- 채널/DM 외 영역 (Workspace 설정, Discover, Friends, Activity) — 단,
  다른 dimension 에서 채널/DM 흐름에 영향 주는 부분만 spot fix 허용
- 새 컴포넌트 / 새 view / 새 페이지
- BE 도메인 신규 endpoint
- Migration (단, fix 가 필요로 하면 round 안에서 reversible 1건 허용)
- E2E framework / Playwright config 전면 개편
- Bundle splitting 전면 재구성

## Acceptance Criteria (mechanical)

- `pnpm verify` green (모든 round 끝나고 최종)
- 8 dimension 각각 매트릭스에 결과 기록 (완료 또는 cap-stopped)
- 모든 BLOCKER + HIGH 해결 또는 명시적 이월 (TODO(task-040-follow-\*) +
  REPORT 에 reason)
- 회귀 spec: 각 fix 마다 1개 이상 추가 또는 기존 spec 보강
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched (`git diff` 0)
- Round log: `docs/tasks/040-round-N-<dim>.md` 누적 (round 수 만큼)
- 3 artefacts: `040-*.md` (task contract), `040-*.PR.md`,
  `040-*.review.md`
- 1 eval: `evals/tasks/051-polish-loop-4.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge (round 별) → main auto-promote (loop 종료 후 1회)
- `.deploy/audit.jsonl` last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 18번째** (loop 종료 후 통합 REPORT)
- FINAL REPORT 자동 출력, 포함:
  - develop/main SHA + exitCode + /readyz + idle + wall clock
  - **Dimension matrix** (8 × round 결과 표 — round 수, BLOCKER 처리,
    HIGH 처리, MED+ 이월 수, 회귀 spec 추가 수)
  - 누적 fix commit 표 (commit SHA → dimension → 요약)
  - 누적 회귀 spec 표 (파일 경로 → cover 하는 fix)
  - Performance baseline (FCP / LCP / CLS / scroll FPS / bundle size)
  - 데스크톱 + 모바일 핵심 흐름 capture (각 dimension 1-2장)
  - Lighthouse score (mobile + desktop)
  - 이월 TODO(task-040-follow-\*) 목록
  - Round 수 + wall clock 총합
- Feature branch retained

## Prerequisite outcomes

- 039 merged + deployed (`83e8cda` main)
- 채널 + DM critical path 동작 (회귀 spec 11 hot-fix 회수 완료)
- 037 custom emoji + 038 magic bytes 운영
- 028 polish harness (회귀 guard) — 이번 task 에서 적극 활용
- 029 mobile.css link / 035 mobile overlay
- 034 Global DM 모델 안정

## Design Decisions

### Round 단위 develop merge

Round 마다 develop 머지 → CI green 조건. 컨텍스트 압축 발생 시
다음 round 부터 resume 가능. 매 round 변경 폭이 작아 review 도
가벼움. main 은 loop 종료 후 1회만 promote — prod 영향 한 번에
관통.

### MED+ 이월 정책

이번 task 는 BLOCKER + HIGH 가 사용자가 요청한 "상용 수준" 의
실질 척도. MED 는 사용자 인지 가능하지만 critical path 막지
않음. backlog 로 두고 040-follow 시리즈에서 처리. LOW 는 일반
적으로 무시 (단, 군집되면 1 round 안에서 batch fix).

### Dimension 진행 순서 (DS → A11y → 흐름)

Visual / accessibility 같은 구조적 layer 가 아래에 있어야
위에서 fix 할 때 baseline 이 안정. 채널/DM core 흐름은 위
fix 들이 누적된 후 통합 audit 으로 잡는다. Performance 는
모든 변경 후 측정해야 의미.

### Round 별 dimension 1개 vs 다수

기본 1 round = 1 dimension. 단 LOW 군집이거나 한 fix 가 여러
dimension 을 동시에 건드리면 1 round 안에서 묶어도 됨. 단,
audit / identify 는 dimension 별로 분리 기록.

### 자율 종료 vs 사용자 개입

024 round cap + 2-round 0-issue convergence 가 종료 보장. cap
도달은 정상 종료로 취급 (사용자 일찍 stop 불가). 단 VERIFY 3회
연속 실패는 round-수준 중단 → 가설 3개 + 사용자 질문 (CLAUDE.md
agent loop 룰).

### Performance dimension 의 baseline

FCP < 1.8s, LCP < 2.5s, CLS < 0.1, scroll FPS 60 desktop / 50
mobile, bundle size delta vs 039 baseline ≤ +5%, Lighthouse
mobile ≥ 85 / desktop ≥ 90. 미달 시 HIGH.

### "상용 수준" 의 정량 정의

- 모든 BLOCKER + HIGH 해결 (또는 명시 이월)
- Lighthouse mobile / desktop 위 임계 충족
- accessibility audit (axe-core) violation = 0 critical / serious
- 회귀 spec 매 fix 마다 추가
- 데스크톱 + 모바일 핵심 흐름 e2e screen-record 통과

### DS source of truth 무수정

수정 욕망이 큰 task (visual consistency dimension). 그러나 메모리
`feedback_design_system_source_of_truth.md` 와 038 의 ds-protection
workflow 가 강제. 변경 필요 시 fix 는 page-scoped CSS 또는
inline style 로만. DS 4파일 자체는 git diff 0 유지.

### Round log 분리

`040-round-N-<dim>.md` 별 파일. 컨텍스트 압축 후 resume 시 round
log 가 자체 진행 상태 카운터 역할. 누적 변경 양 추적 용이.

## Non-goals

- 새 feature
- 아키텍처 / 모델 변경
- DS 4파일 수정
- 채널/DM 외 영역 large fix (Discover / Friends / Activity 등)
- 모든 MED+ issue 일괄 해결
- Bundle / build 시스템 재구성
- E2E framework 변경
- 신규 컴포넌트 / 페이지
- Voice / Group DMs / mecab-ko / 다른 큰 task

## Risks

- **Round 도중 컨텍스트 압축**: 매 round 마다 commit + develop merge
  - round log 파일. resume 시 이전 round log 확인 + dimension matrix
    로 next dim 결정
- **VERIFY 누적 실패**: 한 round 안에서 3회 fail 시 round 중단 →
  가설 3개 + 사용자 질문. cap 도달 시 강제 종료
- **MED 의 군집 폭증**: HIGH 만 처리하면 MED 가 쌓여 follow task 가
  거대해짐. 1 round 끝마다 MED 수 카운트 → 50개 넘으면 follow task
  041 자동 분할 결정
- **Performance dimension 회귀**: visual / a11y / fix 누적이 bundle
  / runtime 영향 미칠 수 있음. round 7 에서 baseline 미달이면 어떤
  앞 round 가 원인인지 git bisect 가능하도록 round 별 commit 분리
- **Mobile audit 의 viewport 한계**: Playwright emulate 만으로는
  실제 IME / safe-area 검증 불완전. 가능한 한 Playwright 로 cover
  - REPORT 에 emulate 한계 명시
- **DS 정합 dimension 의 raw value 대량 발견**: 026/028 의 baseline
  이후에도 신규 코드에서 raw hex 가 들어왔을 가능성. round 안에
  cap 두고 (round 1: 최대 30 fix), 초과 분은 follow
- **Round cap 24 도달 후 미수렴**: 정상 종료 처리 + 미해결 항목
  follow task. cap 의 의미를 cap 으로 강제하지 않으면 무한 루프
- **회귀 spec 작성 비용**: fix 보다 spec 작성이 더 오래 걸리는
  경우 → e2e 보다 가벼운 int / unit 스펙 우선
- **Dimension 간 fix 충돌**: dim 6 (visual) 의 fix 가 dim 5 (mobile)
  의 spec 을 깰 수 있음. round 끝마다 cumulative spec 전체 재실행

## Progress Log

_Implementer 채움 — round 별 entry 추가_

- [ ] UNDERSTAND (031 ~ 039 의 채널/DM 관련 spec 전수, 028 polish
      harness 구조, axe-core 도입 여부, Lighthouse CI 설정 여부,
      현재 bundle size baseline)
- [ ] PLAN approved (dimension 진행 순서 + round cap 명시)
- [ ] SCAFFOLD (round log template, dimension matrix template,
      audit 자동화 스크립트 — Playwright + axe + Lighthouse 묶음)
- [ ] LOOP (각 round 별 sub-progress)
  - [ ] Round 1 — Visual consistency
  - [ ] Round 2 — Accessibility
  - [ ] Round 3 — Error / Empty / Loading
  - [ ] Round 4 — Edge cases
  - [ ] Round 5 — 모바일 viewport
  - [ ] Round 6 — Channel messages
  - [ ] Round 7 — DMs
  - [ ] Round 8 — Performance
  - [ ] (확정 round — 같은 dim 2 round 0-issue convergence 검증)
  - [ ] (필요 시 round 9 ~ 24, dim 별 회차)
- [ ] VERIFY (loop 종료 시 cumulative `pnpm verify` + e2e + axe +
      Lighthouse)
- [ ] OBSERVE (dimension matrix, performance baseline, accessibility
      score, fix commit 표)
- [ ] REFACTOR
- [ ] REPORT (develop → main auto-promote via webhook → 통합 FINAL
      REPORT auto-printed + **pane 1 auto-forwarded 18th**)
