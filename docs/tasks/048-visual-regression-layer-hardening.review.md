# Review — Task 048 (visual-regression-scanner subagent transcript)

**Spawned**: 2026-05-08
**Subagent**: visual-regression-scanner persona on general-purpose runtime
(`.claude/agents/visual-regression-scanner.md` 의 강화된 정의를
briefing 으로 주입)
**agentId**: `a05d2be4b32de1f26`
**Tokens (transcript)**: 32,895
**Tool uses**: 15
**Duration**: 72.5s
**한국어 존댓말**: 유지

## 호출 의도

`.claude/agents/visual-regression-scanner.md` 는 task-044 에서 정의됐으나
044~047 mega-loop 에서 단 1회도 invoked 되지 않음 (호출 누락 0/15, 0%,
audit doc 참조). 048 의 핵심 산출 중 하나가 **agent 호출 의무 자체를
강화 + 048 이 그 의무의 첫 적용**. 따라서 이 review subagent 호출은
visual regression layer 의 자기검증 + 누락 패턴의 break.

## 검증 시나리오

agent 에 다음 read-only check 4 layer 를 위임:

- **A**. baseline reseed 산출물 (snapshot 8 PNG git-tracked, DS 4파일
  md5 untouched)
- **B**. layout regression e2e 작동 (`--project=prod` 7 surface pass)
- **C**. agent 정의 강화 (호출 의무 / prod 시드 강제 / DS-mockup-only
  한계 명시 / dev 시드 금지)
- **D**. Playwright config 분리 (3 project + env 우선)

## 결과 표 (agent 회신 원문 인용)

| Layer | Item                          | Result | Comment                                                                                          |
| ----- | ----------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| A     | snapshot 8 PNG git-tracked    | PASS   | 8 PNG 모두 `git ls-files` 출력에 포함 (desktop 7 + mobile 1)                                     |
| A     | DS 4파일 md5 untouched        | PASS   | tokens/components/mobile/icons 4개 모두 `.task-040-ds-baseline.txt` 와 byte-identical            |
| B     | app-layout-height.e2e.ts 존재 | PASS   | `apps/web/e2e/layout/app-layout-height.e2e.ts` (137 lines, 7 surface)                            |
| B     | prod 실행 7 surface pass      | PASS   | docker playwright v1.48.2-jammy + `--project=prod` 7 passed in 7.5s, height ≥ 684px (95% of 720) |
| C     | "반드시 호출" 명시            | PASS   | agent md L3, L16-17 에 명시 + 호출 누락 = BLOCKER 규정                                           |
| C     | prod 시드 강제                | PASS   | "Baseline 시드 환경 (강제)" 섹션, prod / dist preview 만 허용                                    |
| C     | DS-mockup-only 한계 명시      | PASS   | "DS-mockup-only baseline 의 구조적 한계" 섹션, 047 iter 7 사례 명시                              |
| C     | dev 시드 금지                 | PASS   | "dev (vite HMR) 는 금지 — false negative 가능"                                                   |
| D     | 3 project 명시                | PASS   | playwright.config.ts L79-101 에 local-dev / local-dist / prod (+ 호환 chromium)                  |
| D     | env 우선 메커니즘             | PASS   | `ENV_BASE_URL ?? <default>` 형태로 `PLAYWRIGHT_BASE_URL` 우선                                    |

## BLOCKER / HIGH

**없음**.

## 정정 사항

agent 가 task 명세의 DS 4파일 표기 오류를 짚음:

- 명세: `{tokens,components,mobile,index}.css|.html`
- 실제: `{tokens,components,mobile,icons}.css` (`.task-040-ds-baseline.txt` 기준)

→ `.claude/agents/visual-regression-scanner.md:71` 정정 commit 반영.

## 결론

048 보강 layer (snapshot 시드 + numeric layout assertion + agent 정의
강화 + project 분리) 가 047 iter 7 ErrorBoundary 회귀 패턴을 자동 차단할
준비 완료된 것으로 확인됨. 본 review 자체가 호출 의무의 첫 적용 사례.

## 호출 의무 의 미래 적용

`docs/audits/visual-regression-agent-audit.md` 의 deferred 항목 참조:

- `TODO(task-048-follow-vrs-call-rule)`: task contract template 자체에
  "visual-regression-scanner 호출 N 회 (≥1)" mechanical check 추가
- `TODO(task-048-follow-vrs-baseline-policy)`: baseline 시드 environment
  를 PR.md 의 표준 첫 row 로 두는 PR template 수정
