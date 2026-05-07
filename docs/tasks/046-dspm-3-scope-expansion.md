# Task 046 — DSPM-3 + Scope Expansion (PL Meta-Loop)

## Context

Task 044 (DSPM, 78%→86%) + Task 045 (DSPM-2, 86%→95%) 으로 초기 매트릭스
의 HIGH 갭이 모두 closure 됐다. score 95% 는 동일 매트릭스 안에서의
한계 — 정체에서 깨려면 매트릭스 자체를 확장해야 한다.

이번 task 는:

1. **Carry-over 흡수**: 045 종료 후 reviewer 발견 HIGH 2 + MED 6
2. **매트릭스 확장**: 새 dimension 8개 추가 → score 일시 하락 → "여전히 끌어올릴 영역" 신호
3. **새 HIGH 갭 처리**: 확장된 매트릭스 위에서 다시 ≥ 90% AND HIGH=0 추구

**복원지점** (이미 확보):

- Tag: `v0.45-restore-point` (push 됨)
- Branch: `restore-point/main-707af0a` (push 됨)
- 둘 다 `707af0a` 가리킴

044/045 의 `v0.43-restore-point` / `v0.44-restore-point` 도 살아있음.

**시작 기점**: main = `707af0a` (Task 045 마지막 deploy 후).

## 045 → 046 인계 (Iteration 0 우선)

**Reviewer 발견 (carry-over, 045 closure 후)**:

- **HIGH-1 SSRF-IPv6-mapped-variant** — link unfurl 의 SSRF guard 가
  IPv4-in-IPv6 (`::ffff:127.0.0.1`, `::1`, IPv6 link-local 등) 처리 누락.
  보안 critical.
- **HIGH-2 GDM-members-endpoint** — group DM 의 멤버 목록 endpoint
  누락. UI 진입 시 빈 list.
- **MED 6건** — 045 review.md 참고 (구체적 항목은 UNDERSTAND 단계에서
  확정)

## 매트릭스 확장 (Iteration 1)

기존 60+ row 에 신규 dimension 8개 추가:

1. **모바일 surface 확장 (8개)**

   - composer (입력 / 첨부 / 이모지 / 멘션)
   - DM thread (1:1 + group)
   - reaction picker
   - emoji picker (Unicode + custom)
   - workspace switch (long-press / drawer)
   - sidebar drawer (모바일 전체 navigation)
   - onboarding (첫 진입 흐름)
   - pinned panel (모바일에서 진입)

2. **검색 깊이**

   - autocomplete (typing 중 suggestion)
   - 결과 navigation (이전/다음, 키보드)
   - filter (channel / sender / 기간 / has-attachment)
   - 검색 내 코드블록 / 멘션 highlight

3. **알림 다양성**

   - DnD 시간대 설정 (per-day / weekly schedule)
   - 우선순위 (mention / thread reply / 일반)
   - badge 동작 (unread vs mention / 모바일 OS bridge)
   - 첫 알림 onboarding (권한 요청 + 안내)

4. **Keyboard shortcut cheat sheet**

   - `?` 모달 (모든 단축키 list + 카테고리)
   - 단축키 학습 흐름 (Cmd+K → suggestion)
   - Cheat sheet 다국어 (한국어 키 mnemonic)

5. **Profile 확장**

   - bio (한 줄 + 다단)
   - 링크 (외부 URL list)
   - profile page 데스크톱 + 모바일

6. **Thread follow / 구독**

   - follow toggle
   - follow 상태에 따른 알림 분기
   - 자동 follow (자신이 시작 / 답변)

7. **Empty state 풍부화**

   - 모든 영역 (channel / DM / search / discover / pinned 등)
   - 친절한 메시지 + CTA
   - 일관된 visual pattern (DS 사용)

8. **Error recovery 일관성**
   - 모든 mutation 의 retry pattern
   - 일관된 에러 메시지 (한국어 friendly)
   - recovery action (retry / cancel / 새로고침)

확장 후 매트릭스 ~ 70+ row. score 일시 하락 예상 (95% → 85-88%).

## Sub-agent 라인업

044 의 10개 그대로 재사용 (`.claude/agents/`):

- feature-benchmarker / competitive-capture-analyst / ui-designer /
  ux-heuristic-auditor (sonnet)
- visual-regression-scanner / contract-validator (haiku)
- accessibility-auditor / performance-profiler / security-scanner (sonnet)
- **feature-implementer** (opus)

## Scope (IN) — 자율 반복

### Iteration 0 — Carry-over hot-fix (필수, BLOCKER 게이트)

iteration 1 진입 전 반드시:

- HIGH-1 SSRF-IPv6 fix (security 인프라 강화 — IPv4-mapped, IPv6
  link-local, multicast, reserved ranges 모두 차단)
- HIGH-2 GDM members endpoint 추가 (`GET /me/dms/groups/:gdmId/members`)
- MED 6 batch 처리 (045 review.md 의 list)
- 회귀 spec: SSRF unit (각 변종 대 차단), GDM members int spec
- baseline 시드는 이미 045 에 있음 — 새 surface 추가 시 baseline 갱신
- 시드/fix 실패 = BLOCKER → iteration 1 진입 금지

### Iteration 1 — 매트릭스 확장 (audit only, 코드 변경 0)

- 위 8 dimension 의 row 추가 (`docs/tasks/046-iteration-1-audit.md`)
- 각 row 별 우리 충족도 (✅/🟡/🔵/❌) + 우선순위
- score 재산정 (baseline 95% → 확장 매트릭스 N%)
- IMPLEMENT/REVIEW step 없음, 매트릭스 갱신만

### Iteration 2~N — 새 HIGH 갭 처리

확장된 매트릭스의 HIGH 갭을 1-3 항목씩:

- 모바일 surface 확장 (visual baseline 추가 + 회귀 spec)
- 검색 / 알림 / 단축키 / 프로필 / 스레드 follow / empty state / error recovery 등
- 매 iteration 8-step (044/045 와 동일)
- BLOCKER + HIGH fix-forward, MED+ 이월

### 종료 조건 (045 와 동일하게 strict)

다음 중 하나만:

- parity score (확장 매트릭스 기준) ≥ 90% **AND** HIGH 갭 = 0
- 누적 10 iteration cap (046 자체)
- 2 iteration 연속 score 변동 < 1%

**그 외 사유로 reviewer/메인 agent 가 일찍 종료 결정 시 사용자 질문
trigger** (045 의 strict 강제 패턴 유지). reviewer 가 BLOCKER 발견했더
라도 fix-forward 가능하면 iteration 진행. fix-forward 불가능한 BLOCKER
만 사용자 질문.

### Pane 1 forward

- iteration 별 mini-progress 1줄 (34번~)
- 종료 시 통합 FINAL REPORT 1회

## Scope (OUT)

- 음성 / 영상 / Huddle (사용자 명시)
- Mobile push (FCM/APNS)
- App marketplace / Workflow builder / Slash commands
- Spoiler / Scheduled send
- DS 4파일 수정
- 아키텍처 / 모델 대규모 변경 (단, 기능별 reversible migration 1건 허용)
- E2E framework 변경
- React 19 같은 큰 의존성 변경
- 044/045 에서 처리한 항목 재구현 (회귀 spec 보강만)

## Acceptance Criteria (mechanical)

- iteration 0 carry-over commit 존재 (HIGH-1 SSRF + HIGH-2 GDM members + MED 6)
- iteration 1 매트릭스 확장 audit 산출 (`046-iteration-1-audit.md` + score 재산정)
- `pnpm verify` green (loop 종료 후 최종)
- 종료 조건 충족 (3개 명시 조건 중 하나)
- 모든 BLOCKER + HIGH 해결 또는 명시 이월 + reason
- 회귀 spec: 각 fix 마다 1개 이상
- DS 4파일 untouched (`git diff` 0, md5 baseline `.task-040-ds-baseline.txt` 일치)
- Visual regression baseline 보존 또는 명시 갱신 (모바일 surface 8 추가 시 baseline 시드)
- axe-core: critical=0, serious=0
- iteration 별 deploy 성공 + readyz 200
- 3 artefacts: `046-*.md` (task contract + 누적 progress), `046-*.PR.md`, `046-*.review.md`
- iteration 별 audit / plan log: `046-iteration-N-{audit,plan}.md`
- 1 eval: `evals/tasks/056-dspm-3-scope-expansion.yaml`
- Reviewer subagent 종료 후 1회 스폰 + transcript token 기록
- `.deploy/audit.jsonl` (`/volume2/dockers/qufox-deploy/.deploy/`) last entry `exitCode=0`
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward**: iteration 별 mini-progress + 종료 시 통합 REPORT
- Feature branch `feat/task-046-dspm-3-scope-expansion` retained

## FINAL REPORT 포함 (loop 종료 후)

- develop/main SHA + exitCode + /readyz + idle + wall clock 총합
- iteration 별 결과 표 (N / 처리 항목 / score 변화 / commit SHA)
- **매트릭스 확장 전후 비교** (60+ row 95% → 70+ row N% → 종료 N%)
- 신규 8 dimension 의 처리 표 (각 dimension 별 row 수 + 처리 / 이월)
- HIGH 갭 처리 표 (carry-over 2 + 신규 발견)
- Sub-agent 호출 통계 + 효과 평가
- Visual regression baseline 변경 history (모바일 8 추가)
- 누적 fix commit 표 + 회귀 spec 표
- Performance baseline (bundle / DOM / scroll 정성)
- 데스크톱 + 모바일 핵심 흐름 capture (확장 dimension 별 1-2장)
- 이월 TODO(task-046-follow-\*) 목록
- Iteration 총 수 + wall clock 총합
- DS 4파일 git diff 0 증거 (md5 비교)
- **종료 사유 명시** (3개 명시 조건 중 어느 것)

## Prerequisite outcomes

- 044 (DSPM) + 045 (DSPM-2) merged + deployed (`707af0a` main)
- score 95% baseline (60+ row 매트릭스 기준)
- 045 회귀 spec 누적 (152 API + 107 web tests)
- Sub-agent 10개 (`.claude/agents/`)
- Visual baseline 시드 완료 (045 iter 0)
- 복원지점 `v0.45-restore-point` (push 됨)

## Design Decisions

### Score 일시 하락의 의미

확장된 매트릭스 기준 score 가 일시 하락하는 건 정상. "여전히
끌어올릴 영역이 있다" 는 신호. iteration 0 (carry-over) 와 1
(audit) 후 iteration 2+ 에서 다시 끌어올림.

### 매트릭스 row 추가 시 score 일관성

044 시드 row 의 가중치 (완성=1.0 / 부분=0.5 / 계획=0.25 / 없음=0)
유지. 신규 row 도 동일 룰. HIGH 갭 가중치 ×2 그대로.

### 모바일 surface 8 추가의 visual baseline 시드

045 iter 0 에서 모바일 4개 (home/DM list/channel/settings) 만
시드됨. 이번에 8 추가 → 총 12 모바일 + 7 데스크톱 = 19 baseline.
Iter 0 (carry-over) 와 별개로 Iter 2 (모바일 dimension 처리 시점)
에서 baseline 시드 commit 분리.

### Iteration 1 의 audit-only 특성

코드 변경 없이 매트릭스 확장 audit 만. score 산정 + 우선순위.
deploy 없음 (commit 만, develop merge X). 이는 일반 iteration
패턴 예외.

### Carry-over MED 6 흡수

045 review.md 의 MED list 를 batch 로 처리. 각 fix 회귀 spec.
MED 의 내용은 UNDERSTAND 단계에서 review.md 읽고 확정.

### 매트릭스 확장의 한계

70+ row 가 한계. 이 이상 추가는 DSPM-4 (047) 의 영역. 이번엔
8 dimension + carry-over 만.

### Sub-agent 라인업 변경 없음

044/045 에서 충분히 검증됨. 효과 평가는 FINAL REPORT 에 포함.

## Non-goals

- 음성 / 영상
- Mobile push
- 044/045 에서 처리한 항목 재구현
- 새 Sub-agent 추가
- DS 재디자인
- 새 framework / runtime
- 매트릭스 row > 80 (DSPM-4 영역)

## Risks

- **HIGH-1 SSRF-IPv6 fix 가 link unfurl 깸**: 기존 정상 link 까지
  차단 가능. allowlist 신중 (RFC 1918 + RFC 4193 + IPv4-mapped 만
  block, public IP 는 허용). 단위 테스트 cover 필수
- **HIGH-2 GDM members endpoint 의 권한**: GDM 멤버만 조회 가능 +
  ban/leave 후 차단. authorization guard 명시
- **모바일 8 surface 의 baseline 폭주**: visual regression baseline
  이 19개로 늘어나면 진단 부담. iteration 별 의도 변경 명시 commit
- **Score 산정 일관성 깨짐**: 매트릭스 row 추가/변경 commit 명시.
  과거 iteration 의 score 와 비교 시 baseline 명시
- **검색 dimension 의 BE 의존**: FTS task-015 가 이미 있음.
  autocomplete / filter / navigation 은 FE 중심 + BE는 부분 확장
  (search query API 의 filter 추가)
- **알림 dimension 의 cross-cutting**: notification pref + DnD +
  badge + onboarding 이 한 dimension 안에 묶여 큰 작업. 단독
  iteration 권장
- **Keyboard cheat sheet 가 DS 미사용**: 새 modal 신설 시 DS Modal
  컴포넌트 재사용 강제 (DS 4파일 수정 X)
- **Profile bio 의 마크다운 처리**: 044 markdown parser 재사용 OK
- **Thread follow 의 알림 race**: WS event + DB 업데이트 race
  (subscribed 인지 확인 후 dispatch)
- **Empty state 의 일관성 강제**: 모든 영역에 동일 패턴 적용 시
  대량 변경. 한 iteration 에 5-7 surface 묶고 나머지 follow-up
- **Error recovery 의 cross-cutting**: 모든 mutation에 retry 추가는
  큰 변경. 단계적 — 첫 iter 에서 framework, 나머지는 follow-up
- **컨텍스트 압축**: 046 가 10 iter cap + iter 0/1 + carry-over 흡수
  로 wall-clock 증가. pane 0 컨텍스트 한계 가능. iteration 별
  atomic commit 으로 resume 가능

## Progress Log

_pane 0 채움_

- [ ] UNDERSTAND (045 review.md 의 HIGH 2 + MED 6 / 045 회귀 spec
      152+107 / 매트릭스 row 가중치 / 8 신규 dimension 위치 / SSRF
      현 구현 / GDM members 위치)
- [ ] PLAN approved
- [ ] SCAFFOLD (eval yaml / artefact stub)
- [ ] **Iteration 0 — Carry-over hot-fix** (BLOCKER 게이트, HIGH-1 + HIGH-2 + MED 6)
- [ ] **Iteration 1 — 매트릭스 확장** (audit only, code 변경 0, score 재산정)
- [ ] LOOP
  - [ ] Iteration 2 — 모바일 surface 확장 (visual baseline 8 추가)
  - [ ] Iteration 3 — 검색 깊이
  - [ ] Iteration 4 — 알림 다양성 (단독)
  - [ ] Iteration 5 — Keyboard shortcut cheat sheet + Profile 확장
  - [ ] Iteration 6 — Thread follow + Empty state 풍부화
  - [ ] Iteration 7 — Error recovery 일관성
  - [ ] Iteration 8+ — AUDIT 결과 기반
- [ ] VERIFY (loop 종료 시 cumulative `pnpm verify` + e2e + axe + DS md5 + visual regression baseline 정합)
- [ ] OBSERVE (iteration 결과 표 / 매트릭스 변화 / sub-agent 통계 / capture)
- [ ] REFACTOR
- [ ] REPORT (develop → main auto-promote → 통합 FINAL REPORT auto-printed + **pane 1 auto-forwarded** 종료 1회)
