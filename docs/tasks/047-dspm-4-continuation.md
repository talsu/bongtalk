# Task 047 — DSPM-4 Continuation (PL Meta-Loop, 96-row baseline)

## Context

044 (60→86%) + 045 (86→95%) + 046 (60→96 row 확장 후 79.95%) 누적의
네 번째 사이클. 매트릭스는 **확장하지 않고** (96 row cap), 046 의
미처리 절반 + carry-over 흡수로 79.95% → 90% 도달이 목표.

046 종료 결과:

- score 79.95% (96 row baseline, HIGH×2 적용 76% 정도)
- HIGH 0 (단 4건은 reclassification 으로 closure → 047 에서 production code 정리)
- 각 dim 의 절반만 처리 (BE/UI 한쪽만, framework/individual 적용 안 됨)

**복원지점** (이미 확보):

- Tag: `v0.46-restore-point` (push 됨)
- Branch: `restore-point/main-0ab2837` (push 됨)
- 둘 다 `0ab2837` 가리킴

044/045/046 의 `v0.43~v0.45-restore-point` 도 살아있음.

**시작 기점**: main = `0ab2837` (Task 046 closing docs).

## 046 → 047 인계 (Iteration 0 우선)

### Carry-over (046 reviewer + reclassification)

**HIGH-046-A** thread subscribe channel ACL bypass

- 046 안에서 코드 fix-forward 됨
- 047: spec 보강 + metric 계약 정리

**HIGH-046-B** A9 @here payload 미플러밍

- 046 안에서 코드 fix-forward 됨
- 047: spec 보강 + matrix metric 계약 정리

**MED 5건** (046 reviewer)

- 046 review.md 의 list (UNDERSTAND 단계에서 확정)

**모바일 4 row production code** (046 iter 8 reclassification)

- HIGH→MED/LOW 등급 강등으로 closure 됐던 4건의 실제 production code 정리
- 046 review.md / matrix 정합성

### 96 row 매트릭스 미처리 (046 dim 별)

**Section J (검색)**: J2 (결과 navigation) + J4 (코드블록/멘션 highlight)
**Section K (알림)**: K2 (우선순위) + K3 (badge 동작)
**Section L (단축키)**: L2 (단축키 학습 흐름)
**Section M (Profile)**: M2 (외부 링크) + M3 (profile page 데스크톱+모바일)
**Section N (Thread)**: N3 (자동 follow)
**Section O (Empty state)**: 모든 영역 친절 메시지 + CTA + DS 일관 (분할 가능)
**Section P (Error recovery)**: framework 만 깔림 → individual mutation 적용 (분할 가능)

총 ~12-15 항목 (O/P 는 분할).

## Sub-agent 라인업

044~046 의 10개 그대로 재사용 (`.claude/agents/`):

- feature-benchmarker / competitive-capture-analyst / ui-designer /
  ux-heuristic-auditor (sonnet)
- visual-regression-scanner / contract-validator (haiku)
- accessibility-auditor / performance-profiler / security-scanner (sonnet)
- **feature-implementer** (opus)

## Scope (IN) — 자율 반복

### Iteration 0 — Carry-over 흡수 (필수, BLOCKER 게이트)

iteration 1 진입 전 반드시:

- HIGH-046-A spec/metric 보강 (thread subscribe ACL guard 회귀 spec)
- HIGH-046-B spec/metric 보강 (@here payload e2e + matrix 계약 정리)
- MED 5 batch 처리 (046 review.md list 우선)
- 모바일 4 row production code 정리 (046 reclass 후속)
- 매트릭스 metric 계약 정리 (046 reclass 의 정합성)
- 회귀 spec: 각 fix 마다 1개 이상
- 시드/fix 실패 = BLOCKER → iteration 1 진입 금지

### Iteration 1~N — 96 row 미처리 절반

권장 순서 (1 iter = 1-3 항목):

- **Iter 1**: J2 검색 결과 navigation + J4 highlight (검색 dim 완성)
- **Iter 2**: K2 알림 우선순위 + K3 badge (알림 dim 완성)
- **Iter 3**: L2 단축키 학습 + M2 외부 링크
- **Iter 4**: M3 profile page (데스크톱 + 모바일, 단독)
- **Iter 5**: N3 자동 follow + O 일부 (channel/DM empty)
- **Iter 6**: O 나머지 (search/discover/pinned empty) + P-individual 1차 (mutation 5-7개)
- **Iter 7**: P-individual 2차 + AUDIT 결과 기반 신규
- 이후: AUDIT 우선순위 기반

매 iter 8-step (044/045/046 와 동일).

### 종료 조건 (045/046 와 동일하게 strict)

다음 중 하나만:

- parity score (96 row 기준) ≥ 90% **AND** HIGH 갭 = 0 (재분류 아닌 진짜 fix)
- 누적 10 iteration cap (047 자체)
- 2 iteration 연속 score 변동 < 1pp (수렴 정체)

**그 외 사유로 일찍 종료 결정 시 사용자 질문 trigger**.
**HIGH=0 closure 는 fix 만 인정, reclassification 금지** (046 패턴 차단).
fix-forward 가능한 BLOCKER 는 진행, 불가능한 것만 사용자 질문.

### Pane 1 forward

- iteration 별 mini-progress 1줄 (36번~)
- 종료 시 통합 FINAL REPORT 1회

## Scope (OUT)

- 음성 / 영상 / Huddle (사용자 명시)
- Mobile push (FCM/APNS)
- App marketplace / Workflow builder / Slash commands
- Spoiler / Scheduled send
- DS 4파일 수정
- **매트릭스 row 추가** (96 row cap 유지, 새 dim 은 048 영역)
- 아키텍처 / 모델 대규모 변경 (단, 기능별 reversible migration 1건 허용)
- E2E framework 변경
- React 19 같은 큰 의존성 변경
- 044/045/046 에서 처리한 항목 재구현 (회귀 spec 보강만)
- HIGH=0 closure 를 reclassification 으로 처리

## Acceptance Criteria (mechanical)

- iteration 0 carry-over commit 존재 (HIGH-046-A spec + HIGH-046-B spec + MED 5 + 모바일 4 production)
- `pnpm verify` green (loop 종료 후 최종)
- 종료 조건 충족 (3개 명시 조건 중 하나)
- HIGH 갭 0 의 모든 항목이 실제 fix (reclass 금지)
- 회귀 spec: 각 fix 마다 1개 이상
- DS 4파일 untouched (`git diff` 0, md5 baseline `.task-040-ds-baseline.txt` 일치)
- Visual regression baseline 보존 또는 명시 갱신 (M3 profile page 신규 surface 시 시드)
- axe-core: critical=0, serious=0
- iteration 별 deploy 성공 + readyz 200
- 3 artefacts: `047-*.md` (task contract + 누적 progress), `047-*.PR.md`, `047-*.review.md`
- iteration 별 audit / plan log: `047-iteration-N-{audit,plan}.md`
- 1 eval: `evals/tasks/057-dspm-4-continuation.yaml`
- Reviewer subagent 종료 후 1회 스폰 + transcript token 기록
- `.deploy/audit.jsonl` (`/volume2/dockers/qufox-deploy/.deploy/`) last entry `exitCode=0`
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward**: iteration 별 mini-progress + 종료 시 통합 REPORT
- Feature branch `feat/task-047-dspm-4-continuation` retained
- **HIGH=0 closure 의 fix 증거** (commit hash + 회귀 spec 명시, reclass 시 명시적 사유 + reclass 안 했다는 증명)

## FINAL REPORT 포함 (loop 종료 후)

- develop/main SHA + exitCode + /readyz + idle + wall clock 총합
- iteration 별 결과 표 (N / 처리 항목 / score 변화 / commit SHA)
- **96 row 매트릭스 진행** (시작 79.95% → 종료 N%)
- HIGH 갭 처리 표 (carry-over + 신규 발견, 모두 fix 증명)
- Section 별 처리 표 (J/K/L/M/N/O/P 어느 row 가 처리됐는지)
- Sub-agent 호출 통계 + 효과 평가
- Visual regression baseline 변경 history
- 누적 fix commit 표 + 회귀 spec 표
- Performance baseline (bundle / DOM / scroll 정성)
- 데스크톱 + 모바일 핵심 흐름 capture
- 이월 TODO(task-047-follow-\*) 목록
- Iteration 총 수 + wall clock 총합
- DS 4파일 git diff 0 증거 (md5 비교)
- **종료 사유 명시** (3개 명시 조건 중 어느 것)
- **046 → 047 의 row 정의 변동 없음 증명** (96 row cap 유지)

## Prerequisite outcomes

- 044~046 merged + deployed (`0ab2837` main, code `f268772`)
- 96 row 매트릭스 baseline (046 iter 1 audit)
- 357 unit tests green (api 239 + web 118)
- Sub-agent 10개 (`.claude/agents/`)
- Visual baseline 19 surface (데스크톱 7 + 모바일 12, 045+046)
- 복원지점 `v0.46-restore-point` (push 됨)

## Design Decisions

### 매트릭스 row 추가 금지 (96 cap 유지)

046 doc 의 "70+ row 한계, 80+ 는 048 영역" 가이드. 047 은 같은 96
row 위에서 90% 도달이 핵심. row 추가는 048 (DSPM-5 새 매트릭스
확장) 영역.

### HIGH=0 closure = fix 만, reclass 금지

046 의 HIGH 4건 reclass 패턴 차단. row 의 충족도 ✅/🟡/🔵/❌ 는
실제 구현 상태 기반이고, HIGH 등급은 사용자 가치 + 갭 크기 기반.
"실은 MED 였다" 는 사후 정당화는 strict 종료 조건의 의미를 약화.

### 046 reviewer carry-over 의 spec/metric 보강

HIGH-046-A/B 는 코드 fix-forward 됐으나 회귀 spec 미충족 + matrix
metric 계약 정리 안 됨. 047 iter 0 에서 마무리.

### Section O (Empty state) 와 P (Error recovery) 의 분할

둘 다 cross-cutting (모든 영역에 적용). 한 iter 에 다 처리하면
verify cycle 폭주. iter 5/6/7 에 분할 적용.

### Section M (Profile) 의 단독 iter

profile page 는 새 surface (visual baseline 추가) + 데스크톱+모바일
양쪽 + bio/링크 표시 + 친구 진입점 등 영향 범위 큼. 단독 iter.

### Score 일관성

046 의 96 row 가중치 (완성=1.0 / 부분=0.5 / 계획=0.25 / 없음=0,
HIGH×2) 그대로. 종료 시 simple score (HIGH×1) 와 weighted score
(HIGH×2) 둘 다 보고.

### Sub-agent 라인업 변경 없음

044~046 에서 충분히 검증됨.

## Non-goals

- 음성 / 영상
- Mobile push
- 044~046 처리 항목 재구현
- 새 매트릭스 row (8 dim 이상 확장)
- 새 Sub-agent 추가
- DS 재디자인
- 새 framework / runtime
- HIGH=0 closure 를 reclass 로 처리

## Risks

- **HIGH-046-A spec 작성이 어려움**: thread subscribe ACL bypass 가
  edge case race 일 가능성. unit/int 로 분리, integration 까지
  reproduce 어려우면 unit 만으로 cover + 명시 follow-up
- **모바일 4 production code 정리 범위 모호**: 046 reclass 명시
  list 가 review.md 에만 있을 가능성. UNDERSTAND 단계에서 확정,
  불명확하면 사용자 질문
- **M3 profile page 가 data model 영향**: User schema 의 bio/links
  필드 이미 추가됐는지 확인. 없으면 reversible migration 1건
- **Empty state O 의 일관성 적용 폭**: 한 iter 에 5-7 surface 묶고
  나머지는 follow. 모든 surface 에 동일 component 강제 X (DS 컴포
  넌트 재사용)
- **Error recovery P-individual 의 mutation 식별**: useSendMessage,
  useEditMessage, useDeleteMessage, useReactionAdd, useReactionRemove,
  useChannelCreate, useDmCreate, useGroupDmCreate, useFriendAdd,
  useFriendRemove, usePin, useUnpin, useMute, useUnmute 등. iter
  당 5-7개씩 cover
- **score 80→90 까지 10pp 가 cap 안에 어려움**: 046 페이스 +1~3pp
  / iter. 7 iter 면 +7~21pp 가능. 단 HIGH=0 fix 동시 충족 필수.
  cap 도달 가능성 높음
- **BLOCKER 발견 시 스왑**: reviewer 가 새 BLOCKER 발견하면 fix-forward,
  fix 어려운 BLOCKER 만 사용자 질문. strict 패턴 유지
- **컨텍스트 압축**: pane 0 가 iter 5+ 누적되면 한계 가능. iteration
  별 atomic commit + task doc + iteration log 기반 resume

## Progress Log

_pane 0 채움_

- [ ] UNDERSTAND (046 review.md 의 HIGH-A/B + MED 5 + 모바일 4
      reclass list / 96 row 매트릭스 충족도 분포 / 미처리 row 별
      위치 / Profile 데이터 모델 / Error recovery framework 위치)
- [ ] PLAN approved
- [ ] SCAFFOLD (eval yaml / artefact stub)
- [ ] **Iteration 0 — Carry-over hot-fix** (BLOCKER 게이트, HIGH-046-A spec + HIGH-046-B spec + MED 5 + 모바일 4 production)
- [ ] LOOP
  - [ ] Iteration 1 — J2 + J4 (검색 dim 완성)
  - [ ] Iteration 2 — K2 + K3 (알림 dim 완성)
  - [ ] Iteration 3 — L2 + M2
  - [ ] Iteration 4 — M3 profile page (단독)
  - [ ] Iteration 5 — N3 + O 일부 (channel/DM empty)
  - [ ] Iteration 6 — O 나머지 + P-individual 1차
  - [ ] Iteration 7 — P-individual 2차 + AUDIT 결과
  - [ ] Iteration 8+ — AUDIT 우선순위 기반
- [ ] VERIFY (loop 종료 시 cumulative `pnpm verify` + e2e + axe + DS md5 + visual regression baseline 정합)
- [ ] OBSERVE (iteration 결과 표 / 매트릭스 변화 / sub-agent 통계 / capture)
- [ ] REFACTOR
- [ ] REPORT (develop → main auto-promote → 통합 FINAL REPORT auto-printed + **pane 1 auto-forwarded** 종료 1회)
