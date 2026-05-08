# Visual-regression-scanner agent audit (044 ~ 047)

**Task**: 048 chunk C
**기준 commit**: main `23492be` (047 hot-fix 직후)
**검토 자료**:

- `docs/tasks/044-discord-slack-parity-mega-loop.md` + `.PR.md` + `.review.md` + `044-iteration-{1,2,3}-{audit,plan,result}.md`
- `docs/tasks/045-discord-slack-parity-mega-loop-continuation.md` + `.PR.md` + `.review.md` + `045-iteration-{1..8}-{audit,plan}.md` + `045-FINAL-REPORT.md`
- `docs/tasks/046-dspm-3-scope-expansion.md` + `.PR.md` + `.review.md` + `046-iteration-*.md`
- `docs/tasks/047-dspm-4-continuation.md` + `.PR.md` + `.review.md` + `047-iteration-*.md`
- 045 FINAL REPORT 의 명시적 코멘트: "Agent tool 미노출"

## TL;DR

`.claude/agents/visual-regression-scanner.md` 는 **task-044 에서
정의되어 디스크에 commit 됨에도** 실제 044/045/046/047 mega-loop
세션 어디에서도 **단 1회도 invoked 되지 않았다**. 자율 메가 loop 의
visual regression layer 가 047 iter 7 의 ErrorBoundary 회귀를 잡지
못한 첫 번째 직접 원인.

| task / iter    | UI 변경 여부                                      | VRS 호출 의무 | VRS 실제 호출 | 비고                                                                                                           |
| -------------- | ------------------------------------------------- | ------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| 044 iter 1     | YES (DS mockup parity 시드)                       | YES           | **NO (0)**    | 044 PR.md table: `0  -  미등록 — baseline 자체 미시드`                                                         |
| 044 iter 2     | YES                                               | YES           | **NO**        | baseline 미시드 (H2 carry-over)                                                                                |
| 044 iter 3     | YES                                               | YES           | **NO**        | 동일                                                                                                           |
| 045 iter 0     | YES (visual baseline 8 surface 시드)              | YES           | **NO**        | 045 FINAL REPORT: "본 세션의 Agent tool 미노출. 미래 세션에서 자동 등록 시 동일 코드의 검증 농도 향상 기대"    |
| 045 iter 1~8   | YES (대부분)                                      | YES           | **NO**        | 동일 — 세션 전체에서 sub-agent dispatch 가 작동 안 함                                                          |
| 046 iter 1     | YES (모바일 surface 8 baseline 시드 시도)         | YES           | **NO**        | 046 도 sub-agent 미호출. 결과: mobile-046 8 baseline 디스크 commit 누락 (chunk A doc 참조)                     |
| 046 iter 2     | YES                                               | YES           | **NO**        | 동일                                                                                                           |
| 046 iter 3     | YES                                               | YES           | **NO**        | 동일                                                                                                           |
| 047 iter 1     | YES (DSPM-4 continuation, mobile production code) | YES           | **NO**        | sub-agent 호출 없음                                                                                            |
| 047 iter 2     | YES                                               | YES           | **NO**        | 동일                                                                                                           |
| 047 iter 3     | YES                                               | YES           | **NO**        | 동일                                                                                                           |
| 047 iter 4     | YES (M3 profile page)                             | YES           | **NO**        | 동일                                                                                                           |
| 047 iter 5     | YES                                               | YES           | **NO**        | 동일                                                                                                           |
| 047 iter 6     | YES (P-individual)                                | YES           | **NO**        | 동일                                                                                                           |
| **047 iter 7** | **YES (ErrorBoundary P4 추가)**                   | **YES**       | **NO**        | **회귀 발생 iteration. VRS 가 호출됐어도 DS mockup baseline 만 보면 어차피 못 잡았을 것 (chunk A doc C 참조)** |

호출 의무 대비 호출 횟수: **0 / 15 (0%)**.

## 원인 분석

### 1. Agent tool 미노출 (045 FINAL REPORT 자기진단)

044 의 `.claude/agents/*.md` 10 정의는 디스크에 존재하나, 메가 loop 가
가동된 044~047 세션에서 메인 agent 가 sub-agent dispatch 능력을 받지
못함. 045 FINAL REPORT 가 명시적으로 "Agent tool 미노출, 미래 세션의
자동 등록 시 검증 농도 향상" 표현 사용. 즉 메인 agent 가 의도적으로
skip 한 게 아니라 실행 환경이 sub-agent 를 노출하지 않았다.

확인: 045 FINAL REPORT line `agent dispatch 우회 — 본 세션의 Agent tool
미노출. 미래 세션에서 자동 등록 시 동일 코드의 검증 농도 향상 기대`.

### 2. Description trigger 의 약한 의무 표현

기존 정의 (048 강화 전):

```
description: Playwright `toHaveScreenshot()` 기반 visual regression.
UI 변경 후 호출. 코드 변경 안 함, 검증만.
```

"UI 변경 후 호출" 은 권고형. 메인 agent 가 호출 여부를 판단으로 두고,
sub-agent 가 노출돼 있어도 "변경이 작아 보이면 skip" 가능.

### 3. Task contract 의 명시 step 결여

044~047 task doc 의 Acceptance Criteria 어디에도
"visual-regression-scanner 호출 N 회" 류의 mechanical check 없음. 즉
호출 자체가 verifiable artefact 가 아니어서 누락이 보고에 안 잡힘.
048 부터는 PR.md 표 + FINAL REPORT 의 "Reviewer subagent transcript
token" 처럼 명시.

### 4. Baseline 의 DS-mockup-only 한정 (구조적 한계)

가정으로, sub-agent 가 호출됐어도 visual snapshot 이 `/design-system/`
페이지만 보고 real app routes 를 안 보면 ErrorBoundary 회귀는 어차피
못 잡았을 것. 즉 agent 호출 누락 + baseline coverage 부족 의 **이중
실패**. chunk B 의 `app-layout-height.e2e.ts` 가 후자에 numeric
검증 layer 추가.

## 강화 후 agent description (chunk C 산출)

`.claude/agents/visual-regression-scanner.md` 의 frontmatter +
description 을 다음과 같이 강화:

- **호출 trigger 강화**: "UI 코드 변경 (`apps/web/src/components/`,
  `features/`, `shell/`, `design-system/`) 또는 layout 관련 commit
  (`AppLayout`, `ErrorBoundary`, `Suspense` boundary) **후 반드시
  호출**. 메인 agent 가 호출 누락 시 BLOCKER 로 회귀 책임."
- **baseline 시드 환경 강제**: "baseline 캡처는 prod
  (`https://qufox.com`) 또는 prod-equivalent dist preview
  (`pnpm --filter @qufox/web build && preview`) 에서만. dev (vite
  HMR) 시드는 hydration / asset 경로 차이로 false negative 가능 →
  금지."
- **호출 의무 명시**: "각 iteration 의 UI/UX 검증 단계에서 1 회 이상.
  invoked 횟수를 PR.md 표 / FINAL REPORT 에 명시 기록 필수."

## 048 의 VRS 호출

본 task 자체에서 `.claude/agents/visual-regression-scanner.md` 강화
이후 visual-regression-scanner subagent 를 1회 spawn (chunk C 산출물
중 하나). transcript token 은 PR.md 에 기록.

## Deferred

- `TODO(task-048-follow-vrs-call-rule)`: task contract template 자체에
  "visual-regression-scanner 호출 N 회 (≥1)" mechanical check 추가
- `TODO(task-048-follow-vrs-baseline-policy)`: baseline 시드 environment
  를 PR.md 의 표준 첫 row 로 두는 PR template 수정
