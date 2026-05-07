# Task 045 — Discord / Slack Parity Mega-Loop Continuation (DSPM-2)

## Context

Task 044 (DSPM) 가 종료 조건 미충족 상태로 reviewer 판단에 의해 일찍
closed 됐다. score 78% → 86% (3 iter, +8%). HIGH 4건 + reviewer 발견
2건 (H1/H2) 가 task-045 로 이월. 이번 task 는 **continuation** —
같은 자율 메가 loop 패턴을 이어서 진행하되, 종료 조건 강제 + iteration
0 visual baseline 시드 누락 방지 강화.

**복원지점** (이미 확보):

- Tag: `v0.44-restore-point` (push 됨)
- Branch: `restore-point/main-a8cc66b` (push 됨)
- 둘 다 `a8cc66b` 가리킴

044 의 `v0.43-restore-point` 도 살아있음 (한 단계 전).

**시작 기점**: main = `a8cc66b` (Task 044 마지막 deploy 후).

## 044 → 045 인계 항목

**HIGH 갭 4건 (이월)**:

1. **Link unfurl / OpenGraph 임베드** — `.qf-embed` CSS 만, BE 0
2. **Channel/DM mute** — pref 가 event-type 단위만
3. **Group DM (3+)** — backlog, 미구현
4. **Custom status text** — presence enum-only

**Reviewer 발견 2건 (045 첫 priority)**:

- **H1 pin-cap-race** — pinned-BE iter 2 의 cap 50 race condition (concurrent pin → 50 초과 가능)
- **H2 visual-baseline-seed** — 044 doc 의 iteration 0 명시 step 누락 → visual regression 검증 무력화

**044 처리 완료 (인계 X)**:

- markdown bold/italic/strike/quote
- pinned-BE (schema/API/cap50/WS)
- @everyone 권한 게이트

**기타**:

- pinned UI (BE 만 있고 UI 누락) — 045 우선

## Parity 매트릭스 시드 (045 시작 기점)

- 044 종료 시 score 86%
- 목표: ≥ 90% AND HIGH 갭 = 0
- 현재 HIGH 갭 4건 + 이월 2건 + pinned UI 누락
- 모두 처리 시 추정 score ~94-96%

## Sub-agent 라인업

044 의 10개 그대로 재사용 (`.claude/agents/`):

- feature-benchmarker / competitive-capture-analyst / ui-designer /
  ux-heuristic-auditor (sonnet)
- visual-regression-scanner / contract-validator (haiku)
- accessibility-auditor / performance-profiler / security-scanner (sonnet)
- **feature-implementer** (opus)

## Scope (IN) — 자율 반복

### Iteration 0 — Visual baseline 시드 (필수, 첫 단계)

044 에서 누락된 step. iteration 1 시작 전 **반드시** 실행:

- `apps/web/e2e/visual/` 디렉토리 신규 (없으면)
- 핵심 surface 11개 baseline 캡처:
  - 데스크톱 (7): shell / channel-empty / channel-with-messages /
    DM list / DM thread / settings / discover
  - 모바일 (4, 375x667): home / DM list / channel / settings
- Playwright 미설치 시 `pnpm playwright install` 또는 docker compose
  service 활용
- `pnpm playwright test --update-snapshots` 1회
- baseline commit 분리 (`chore(visual-regression): seed baseline @ a8cc66b`)
- baseline 시드 실패 시 BLOCKER → iteration 1 진입 금지

### Iteration 8-step (044 와 동일)

각 iteration 은:

1. AUDIT — score 갱신 + top HIGH gap 식별 → `045-iteration-N-audit.md`
2. PRIORITIZE — 1-3 항목 (Group DM 같은 큰 항목은 단독 iteration)
3. PLAN — feature-benchmarker + ui-designer 병렬 → `045-iteration-N-plan.md`
4. IMPLEMENT — feature-implementer (Opus) red→green→refactor
5. UI/UX 검증 — 5 agent 일괄 (visual regression 이 baseline 위에서 작동)
6. REGRESSION — 3 agent 일괄 (contract-validator + performance-profiler + security-scanner)
7. DEPLOY — develop merge → main auto-promote, mini-progress pane 1 forward
8. DECIDE — 종료 조건 평가

### 045 첫 iteration 권장 순서

- **Iteration 1**: H1 pin-cap-race fix + pinned UI (BE 만 있고 UI 누락)
- **Iteration 2**: link unfurl + OpenGraph 임베드 (BE + FE 동반, 별도 iteration)
- **Iteration 3**: channel/DM mute (notification 인프라 확장)
- **Iteration 4**: custom status text (presence 확장)
- **Iteration 5+**: group DM (큰 항목, 단독 iteration 권장)
- 이후: AUDIT 결과 기반 신규 발견

### 종료 조건 (044 와 동일하나 **강제**)

다음 중 하나만:

- parity score ≥ 90% **AND** HIGH 갭 = 0
- 누적 10 iteration cap (045 자체)
- 2 iteration 연속 score 변동 < 1% (수렴 정체)

**그 외 사유로 reviewer/메인 agent 가 일찍 종료 결정 시 사용자 질문 trigger**
(044 의 일찍 종료 패턴 방지). reviewer 가 BLOCKER 발견했더라도 fix-forward
가능하면 진행. fix-forward 불가능한 BLOCKER 만 사용자 질문.

### Pane 1 forward

- iteration 별 mini-progress 1줄 (26번~)
- 종료 시 통합 FINAL REPORT 1회 (마지막 + 1번)

## Scope (OUT)

- 음성 / 영상 / Huddle (사용자 명시)
- Mobile push (FCM/APNS)
- App marketplace / Workflow builder / Slash commands
- Spoiler / Scheduled send
- DS 4파일 수정
- 아키텍처 / 모델 대규모 변경 (단, 기능별 reversible migration 1건 허용)
- E2E framework 변경
- React 19 같은 큰 의존성 변경
- 044 에서 이미 처리한 markdown / pinned-BE / @everyone-gate (회귀만)

## Acceptance Criteria (mechanical)

- iteration 0 visual baseline 시드 commit 존재 + 모든 surface snapshot 파일 생성 확인
- `pnpm verify` green (loop 종료 후 최종)
- 종료 조건 충족 (3개 명시 조건 중 하나)
- 모든 BLOCKER + HIGH 해결 또는 명시 이월 + reason
- 회귀 spec: 각 fix 마다 1개 이상
- DS 4파일 untouched (`git diff` 0, md5 baseline `.task-040-ds-baseline.txt` 일치)
- Visual regression baseline 보존 또는 명시 갱신 (의도된 변경)
- axe-core: critical=0, serious=0
- iteration 별 deploy 성공 + readyz 200
- 3 artefacts: `045-*.md` (task contract + 누적 progress), `045-*.PR.md`, `045-*.review.md`
- iteration 별 audit / plan log: `045-iteration-N-{audit,plan}.md`
- 1 eval: `evals/tasks/055-dspm-continuation.yaml`
- Reviewer subagent 종료 후 1회 스폰 + transcript token 기록
- `.deploy/audit.jsonl` (`/volume2/dockers/qufox-deploy/.deploy/`) last entry `exitCode=0`
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward**: iteration 별 mini-progress + 종료 시 통합 REPORT
- Feature branch `feat/task-045-dspm-continuation` retained

## FINAL REPORT 포함 (loop 종료 후)

- develop/main SHA + exitCode + /readyz + idle + wall clock 총합
- iteration 별 결과 표 (N / 처리 항목 / score 변화 / commit SHA)
- **최종 parity 매트릭스** (시작 86% → 종료 N%)
- HIGH 갭 처리 표 (이월 4 + reviewer 2 + 신규 발견)
- Sub-agent 호출 통계 + 효과 평가
- Visual regression baseline 변경 history (045 시작 시 시드 + 의도 변경)
- 누적 fix commit 표 + 회귀 spec 표
- Performance baseline (bundle / DOM / scroll 정성)
- 데스크톱 + 모바일 핵심 흐름 capture
- 이월 TODO(task-045-follow-\*) 목록
- Iteration 총 수 + wall clock 총합
- DS 4파일 git diff 0 증거 (md5 비교)
- **종료 사유 명시** (3개 명시 조건 중 어느 것)

## Prerequisite outcomes

- 044 (DSPM) merged + deployed (`a8cc66b` main)
- markdown / pinned-BE / @everyone-gate 회귀 spec 22건 누적
- 040~043 의 polish + virtualization
- Sub-agent 10개 (`.claude/agents/`)
- 복원지점 `v0.44-restore-point` (push 됨)

## Design Decisions

### 044 의 일찍 종료 패턴 방지

044 doc 종료 조건이 명확했음에도 reviewer 판단으로 일찍 종료. 045 는
종료 조건을 strict 하게 강제 — reviewer 가 BLOCKER 발견했더라도
fix-forward 가능하면 iteration 진행. fix-forward 불가능한 경우만
사용자 질문.

### Iteration 0 visual baseline 시드 강제

044 H2 의 핵심. baseline 없으면 visual-regression-scanner 가 무의미.
iteration 1 진입 전 시드 실패 = BLOCKER.

### H1 pin-cap-race 의 우선순위

044 의 pinned-BE 에 race condition 잔존. 045 iter 1 에서 pinned UI
와 함께 fix. transaction + advisory lock 또는 cap 체크의 atomicity
강화.

### Group DM 의 단독 iteration

데이터 모델 (DIRECT 채널의 multi-recipient) + UI 흐름 + 알림
연동까지 포함. 한 iteration 에 다른 항목과 묶으면 verify cycle
폭주 가능. 단독 처리.

### Score 산정 일관성

044 의 매트릭스 row/가중치 시드 그대로 사용. 045 에서 row 추가/변경
시 명시 commit. 값 비교 일관성 유지.

### Iteration cap 10 (045 자체)

044 의 cap 10 은 이미 closed. 045 도 새로 10. 이는 045 라는 새 task
의 cap 이지 044 누적 cap 의 연장 아님. 단, 누적 wall-clock 은 길
어질 수 있음 — pane 1 은 그동안 다른 task 검토 가능.

### Sub-agent 라인업 변경 없음

044 의 10개로 충분 검증됨. 신규 추가 없음. 효과 평가는 FINAL REPORT
에 포함.

## Non-goals

- 음성 / 영상
- Mobile push
- 044 에서 처리한 항목 재구현 (회귀 spec 보강만)
- 새 Sub-agent 추가
- DS 재디자인
- 새 framework / runtime

## Risks

- **iteration 0 baseline 시드 실패**: Playwright NAS 미설치 시 전체
  중단. 시작 시 `pnpm playwright install` 또는 docker compose 명시
- **pin-cap-race 의 race 재현 어려움**: concurrent test 작성이
  어려움. Promise.all 시뮬 + advisory lock 검증으로 대체
- **Group DM 의 데이터 모델 영향**: DIRECT 채널 multi-recipient 가
  030 workspace-scoped DM, 034 global DM, 041 DM presence 와 호환
  되어야 함. UNDERSTAND 단계에서 영향 분석 우선
- **link unfurl SSRF**: URL fetch 시 internal IP / file:// scheme
  차단. SSRF guard fetcher 필수. security-scanner 가 critical 잡으면
  BLOCKER
- **Channel mute 의 notification pref 충돌**: event-type 단위 + channel
  단위 + DM 단위 prefs 가 동시 존재 시 우선순위 (mute > pref)
  명확히
- **Custom status text 의 presence 동기화**: WS broadcast 빈도 증가
  가능. 변경은 throttle (10s)
- **종료 사유 strict 강제 가 무한 loop 위험**: cap 10 은 단단한 상한.
  명시 조건 외 종료는 질문. 그래도 cap 10 면 11회차 안 도달
- **사용자가 wall-clock 길어짐 인지**: 045 가 5-10시간 가능. 메가
  loop 의 본질
- **Reviewer 가 "045 안전 종료" 라며 또 일찍 닫음**: 045 의 strict
  강제로 차단. 그래도 발생 시 사용자가 알아챔
- **컨텍스트 압축**: pane 0 가 iteration 5+ 누적되면 한계 가능. 045
  doc + iteration log 기반 resume 가능

## Progress Log

_pane 0 채움_

- [ ] UNDERSTAND (044 회귀 spec 누적 / H1 race 위치 / pinned UI 위치
      / link unfurl 위치 / mute 인프라 / Group DM 모델 영향 / custom
      status presence 흐름)
- [ ] PLAN approved
- [ ] SCAFFOLD (eval yaml / artefact stub)
- [ ] **Iteration 0 — Visual baseline 시드** (필수, BLOCKER 게이트)
- [ ] LOOP
  - [ ] Iteration 1 — H1 pin-cap-race + pinned UI
  - [ ] Iteration 2 — link unfurl / OpenGraph (BE + FE)
  - [ ] Iteration 3 — channel/DM mute
  - [ ] Iteration 4 — custom status text
  - [ ] Iteration 5+ — group DM (단독)
  - [ ] Iteration 6+ — AUDIT 결과 기반
- [ ] VERIFY (loop 종료 시 cumulative `pnpm verify` + e2e + axe + DS md5 + visual regression baseline 정합)
- [ ] OBSERVE (iteration 결과 표 / 매트릭스 변화 / sub-agent 통계 / capture)
- [ ] REFACTOR
- [ ] REPORT (develop → main auto-promote → 통합 FINAL REPORT auto-printed + **pane 1 auto-forwarded** 종료 1회)
