# Task 044 — Discord / Slack Parity Mega-Loop (DSPM)

## Context

Beta 진입 전 텍스트 채팅 + DM 영역을 **Discord/Slack 수준** 으로
끌어올린다. 음성/영상/Huddle 은 의도적 OUT. 사용자 개입 없이
자율 N-iteration meta-loop 로 수렴.

**복원지점** (이미 확보):

- Tag: `v0.43-restore-point`
- Branch: `restore-point/main-ea5ae50`
- 둘 다 `ea5ae50` 가리킴

**시작 기점**: main = `ea5ae50` (Task 043 머지 후).

## Parity 매트릭스 (시드 — pane 1 사전 조사 결과)

60+ 항목 중 **HIGH 갭 7개**. 현재 score ≈ 78%.

- 가중치: 완성=1.0 / 부분=0.5 / 계획=0.25 / 없음=0
- 목표: ≥ 90% **AND** HIGH 갭 = 0

**HIGH 갭 (시드 우선순위)**:

1. **Pinned messages** — schema/UI 모두 0
2. **Markdown bold/italic/strike/quote** — `parseContent` 가 fence + inline code 만
3. **Link unfurl / OpenGraph 임베드** — `.qf-embed` CSS 만, BE 0
4. **Channel/DM mute** — pref 가 event-type 단위만
5. **@everyone/@here 권한 게이트** — JSON 만, sender 권한 + receiver 분기 0
6. **Group DM (3+)** — backlog, 미구현
7. **Custom status text** — presence enum-only

**Round 시드 (3개 묶음, 변경 가능)**:

- A: pinned + markdown + link unfurl (메시지 표면)
- B: mute + mention permission + group DM (notification/social)
- C: custom status + profile + thread follow (social signal)

iteration 진행 중 매트릭스 갱신 → 우선순위 재산정 가능.

## Sub-agent 라인업 (`.claude/agents/`)

이번 task 용 10개 신규 (이미 작성됨):

| Name                        | Model    | Role                                  |
| --------------------------- | -------- | ------------------------------------- |
| feature-benchmarker         | sonnet   | Discord/Slack 기능 web 조사 + UX spec |
| competitive-capture-analyst | sonnet   | Discord/Slack ↔ qufox 비교 표        |
| ui-designer                 | sonnet   | DS 정합 + 컴포넌트 구조               |
| ux-heuristic-auditor        | sonnet   | Nielsen 10 + cognitive walkthrough    |
| visual-regression-scanner   | haiku    | Playwright snapshot diff              |
| accessibility-auditor       | sonnet   | WCAG 2.1 AA + axe-core                |
| contract-validator          | haiku    | Zod ↔ class-validator ↔ UI          |
| performance-profiler        | sonnet   | N+1 / bundle / WS 빈도                |
| security-scanner            | sonnet   | OWASP + gitleaks                      |
| **feature-implementer**     | **opus** | red→green→refactor 본체               |

조율은 pane 0 메인 agent (Opus). Bash 권한은 검증 목적으로만.

## Scope (IN) — 자율 반복

### Iteration 8-step

각 iteration 은 다음 step 으로 진행:

1. **AUDIT**

   - feature matrix score 갱신
   - top HIGH gap 3-5개 식별
   - 산출: `docs/tasks/044-iteration-N-audit.md`

2. **PRIORITIZE**

   - gap × 사용자 가치 × 구현 난이도 → 이번 iteration 처리할 항목 선정
   - 한 iteration 당 1-3 항목 권장 (Round 시드 묶음 참고)

3. **PLAN**

   - 항목 별 spec: data model + API + UX flow + 회귀 spec 명세
   - feature-benchmarker + ui-designer 병렬 호출
   - 산출: `docs/tasks/044-iteration-N-plan.md`

4. **IMPLEMENT**

   - feature-implementer (Opus) 가 red→green→refactor
   - Prisma migration 은 reversible
   - 항목 별 commit 분리 (`feat(parity-<feature>): ...`)

5. **UI/UX 검증** (강화 메서드 5종 일괄)

   - ui-designer: DS 정합 + 컴포넌트 구조
   - ux-heuristic-auditor: Nielsen 10 + walkthrough
   - visual-regression-scanner: snapshot diff (baseline 갱신은 명시 의도 시만)
   - accessibility-auditor: WCAG 2.1 AA + axe (critical/serious=0)
   - competitive-capture-analyst: Discord/Slack ↔ qufox 비교 표
   - 발견 BLOCKER + HIGH 즉시 fix-forward, MED+ 는 TODO(task-044-iteration-N-follow-\*)

6. **REGRESSION**

   - 각 fix 마다 e2e/int/unit spec 1개 이상
   - contract-validator + performance-profiler + security-scanner 호출
   - critical/serious 등급 모두 fix-forward

7. **DEPLOY**

   - develop merge → main auto-promote (iteration 단위)
   - `.deploy/audit.jsonl` (`/volume2/dockers/qufox-deploy/.deploy/`) 확인
   - `/api/readyz` 200 + idle 30s
   - **iteration mini-progress 1줄을 pane 1 으로 forward** (score + 처리 항목)

8. **DECIDE**
   - score / cap / convergence 평가
   - 종료 조건 충족 → loop 종료, 아니면 다음 iteration

### 종료 조건 (정량)

다음 중 하나라도 충족 시 종료:

- parity score ≥ 90% **AND** HIGH 갭 = 0
- 누적 10 iteration cap
- 2 iteration 연속 score 변동 < 1% (수렴 정체)

### Pane 1 forward

- 매 iteration 끝마다 짧은 mini-progress 1줄 (22번~)
- 최종 종료 시 통합 FINAL REPORT 1회 (마지막 + 1번)

### Visual regression baseline 시드 (iteration 0)

iteration 1 시작 전:

- `apps/web/e2e/visual/` 디렉토리 신규 (없으면)
- 핵심 surface 6-10개 baseline 캡처:
  - 데스크톱: shell / channel-empty / channel-with-messages / DM list / DM thread / settings / discover
  - 모바일 (375x667): home / DM list / channel / settings
- `pnpm playwright test --update-snapshots` 1회
- baseline commit 분리 (`chore(visual-regression): seed baseline @ ea5ae50`)

## Scope (OUT)

- 음성 / 영상 / Huddle / 화상회의 (사용자 명시)
- Mobile push (FCM/APNS) — NAS-only
- App marketplace / Workflow builder / Slash commands (LOW)
- Spoiler `||x||` (Discord-only, LOW)
- Scheduled send (LOW)
- Bot user / API token marketplace
- Server boost / 결제
- DS 4파일 (`tokens.css` / `components.css` / `mobile.css` / `icons.css`) 수정
- 아키텍처 / 모델 대규모 변경 (단, 기능별 reversible migration 1건 허용)
- E2E framework / Playwright config 전면 개편
- Bundle splitting 전면 재구성
- React 19 같은 큰 의존성 변경

## Acceptance Criteria (mechanical)

- `pnpm verify` green (모든 iteration 끝나고 최종)
- iteration 별 audit / plan / commit / spec 누적 기록
- 종료 조건 충족 (score ≥ 90% + HIGH=0, 또는 cap 10, 또는 convergence)
- 모든 BLOCKER + HIGH 해결 또는 명시 이월 + reason
- 회귀 spec: 각 fix 마다 1개 이상
- DS 4파일 untouched (`git diff` 0, md5 baseline `.task-040-ds-baseline.txt` 일치)
- Visual regression baseline 보존 또는 명시 갱신 (의도된 변경)
- axe-core: critical=0, serious=0
- iteration 별 deploy 성공 + readyz 200
- 3 artefacts: `044-*.md` (task contract + 누적 progress), `044-*.PR.md`, `044-*.review.md`
- iteration 별 audit / plan log: `044-iteration-N-{audit,plan}.md`
- 1 eval: `evals/tasks/054-discord-slack-parity-mega-loop.yaml`
- Reviewer subagent 종료 후 1회 스폰 + transcript token 기록
- `.deploy/audit.jsonl` (`/volume2/dockers/qufox-deploy/.deploy/`) last entry `exitCode=0` + sha = main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward**: iteration 별 mini-progress (1줄) + 종료 시 통합 REPORT (22번~)
- Feature branch `feat/task-044-dspm` retained

## FINAL REPORT 포함 (loop 종료 후)

- develop/main SHA + exitCode + /readyz + idle + wall clock 총합
- iteration 별 결과 표 (N / 처리 항목 / score 변화 / commit SHA)
- **최종 parity 매트릭스** (시작 78% → 종료 N%)
- HIGH 갭 처리 표 (시드 7개 + 추가 발견)
- Sub-agent 호출 통계 (agent 별 호출 수 + 총 token)
- Visual regression baseline 변경 history
- 누적 fix commit 표 + 회귀 spec 표
- Performance baseline (bundle / DOM / scroll 정성)
- 데스크톱 + 모바일 핵심 흐름 capture (iteration 별 1-2장)
- 이월 TODO(task-044-follow-\*) 목록
- Iteration 총 수 + wall clock 총합
- DS 4파일 git diff 0 증거 (md5 비교)
- Sub-agent 라인업 효과 평가 (어느 agent 가 가장 가치 있었는지)

## Prerequisite outcomes

- 040 (PL4) + 041 (sweep) + 042 (PL5) + 043 (virtualization) merged + deployed
- ConnectionBanner / sendFailureToast / clampAttachments / DM presence dot
- 메시지 list virtualized (043) — pinned/markdown/embed 변경 시 측정 재계산 필요
- input-label-guard 정적 audit harness
- 026/028 polish harness
- 복원지점 `v0.43-restore-point` (push 됨)
- Sub-agent 10개 정의 완료 (`.claude/agents/`)

## Design Decisions

### 메가 loop 의 자율성 한계

VERIFY 3회 연속 실패 시 iteration 중단 + 가설 3개 + 사용자 질문
(CLAUDE.md agent loop 룰). 그 외엔 사용자 개입 0.

### Sub-agent 호출 패턴

- AUDIT 단계: 메인 agent 가 직접 (가벼운 grep)
- PLAN 단계: feature-benchmarker + ui-designer 병렬
- IMPLEMENT 단계: feature-implementer (Opus) 가 단독
- UI/UX 검증: 5 agent 일괄 (ui-designer / ux-heuristic-auditor / visual-regression-scanner / accessibility-auditor / competitive-capture-analyst)
- REGRESSION 검증: contract-validator + performance-profiler + security-scanner 일괄
- 종료 review: reviewer subagent 1회

### Score 산정

- 항목 = 60+ 매트릭스의 모든 row
- 가중치: 완성=1.0 / 부분=0.5 / 계획=0.25 / 없음=0
- HIGH 갭의 가중치 ×2 (사용자 체감 영향 큼)
- score = (완성 항목 가중 합) / (전체 가중 합) × 100

### Round 시드는 변경 가능

A → B → C 권장이지만, AUDIT 결과에 따라 우선순위 재산정. 한
iteration 에 1-3 항목, 너무 큰 항목 (예: Group DM) 은 단독 iteration.

### Visual regression baseline drift

iteration 별 변경이 누적되면 baseline 도 갱신. 변경 의도 명확
하면 `--update-snapshots` 명시 commit. 의도 불명 변경은 BLOCKER.

### MED+ 이월 정책

PL4/PL5 동일. BLOCKER + HIGH 만 fix-forward. MED+ 는 TODO(task-044-
iteration-N-follow-\*) 로 이월. 누적 backlog 가 50+ 면 별도 sweep
task 분할.

### 사용자 개입 0 의 운영 의미

매 iteration 끝마다 pane 1 으로 1줄 mini-progress forward. 사용자가
보고 받되 결정은 하지 않음. 종료 후 통합 REPORT.

## Non-goals

- 음성 / 영상 / Huddle
- Mobile push (FCM/APNS)
- App marketplace
- Slash commands / Workflow builder
- Bot 마켓
- Spoiler / Scheduled send
- DS 재디자인
- 새 framework / runtime
- React 19 migration
- 결제 / 보안 토큰 발급 시스템

## Risks

- **Sub-agent 권한 폭증**: tools allowlist 엄격히 (Edit 권한은 feature-implementer 만). 검증 agent 들은 Read/Grep/Glob/Bash(검증 전용)
- **Opus rate-limit**: feature-implementer 가 Opus. rate-limit 시 메인 agent 가 Sonnet 으로 위임 fallback
- **VERIFY 3회 fail 누적**: iteration 중단 + 사용자 질문 (CLAUDE.md 룰)
- **Visual regression baseline 폭주**: iteration 별 의도 변경이 누적 → baseline review 가 부담. iteration 별 명시 commit + 변경 영역 한정
- **Score drift**: 매트릭스 항목 정의가 모호하면 score 가 임의. row/가중치 시드 고정 + 변경 시 명시 commit
- **메가 loop 의 wall-clock**: 10 iteration × 30-60분 = 5-10시간 가능. pane 1 은 그동안 다른 작업 가능 (별도 task 검토 등)
- **컨텍스트 압축**: pane 0 가 iteration 5+ 누적되면 컨텍스트 한계 가능. iteration 별 atomic commit + task doc 기반 resume 가능
- **Discord/Slack 의 새 변화**: 조사 시점 이후 정책 변경 가능. 출처 URL 명시 + 인용 시점 기록
- **종료 조건 미충족**: cap 10 도달했는데 score < 90% 면 정상 종료 + 이월. backlog → 045 후속
- **Sub-agent 간 협업 race**: PLAN 단계 병렬 호출 결과가 충돌하면 메인 agent 가 통합. 같은 surface 동시 변경 X
- **NAS 환경 한계**: Playwright + axe 가 NAS 에 없을 수 있음. 시작 시 `pnpm playwright install` + axe 의존성 확인

## Progress Log

_pane 0 채움_

- [ ] UNDERSTAND (sub-agent 정의 / parity 매트릭스 / Round 시드 / 복원지점 / 검증 인프라)
- [ ] PLAN approved
- [ ] SCAFFOLD (eval yaml / artefact stub / Visual regression baseline 시드)
- [ ] LOOP (iteration 별 sub-progress)
  - [ ] Iteration 1 — Round A 시드 (pinned + markdown + link unfurl)
  - [ ] Iteration 2 — Round B 시드 (mute + mention permission + group DM)
  - [ ] Iteration 3 — Round C 시드 (custom status + profile + thread follow)
  - [ ] Iteration 4+ — AUDIT 결과 기반 우선순위
- [ ] VERIFY (loop 종료 시 cumulative `pnpm verify` + e2e + axe + DS md5 baseline)
- [ ] OBSERVE (iteration 결과 표 / 매트릭스 변화 / sub-agent 통계 / capture)
- [ ] REFACTOR
- [ ] REPORT (develop → main auto-promote → 통합 FINAL REPORT auto-printed + **pane 1 auto-forwarded** 종료 1회)
