# Task 049 — Verification & Stability Debt Cleanup

## Context

048 (visual regression layer hardening) 은 047 iter 7 의 ErrorBoundary
prod BLOCKER (화면 전체가 workspace rail 아이콘 stack 높이로 collapse,
**사용자 직접 신고로 발견**) 의 process 결함을 정밀 조사하고, numeric
layout assertion e2e (chunk B, `app-layout-height.e2e.ts`) 로 응급
처치했다. 그러나 근본 부채 3건은 명시적으로 deferred 됐다:

1. `TODO(task-048-follow-real-app-baseline)` — **visual baseline 19개가
   전부 `/design-system/index.html` (정적 DS mockup) 만 캡처**.
   `apps/web/src/App.tsx` 의 AppLayout / Routes / ErrorBoundary 트리는
   visual baseline 의 검증 대상이 **한 번도 아니었다**. 이것이 047 iter 7
   회귀가 snapshot 으로 안 잡힌 구조적 원인.
   (`docs/visual-regression-broken-baselines.md` C 항)
2. `TODO(task-048-follow-mobile-046-broken)` — **mobile-046 8 surface
   baseline 이 디스크에 존재하지 않음**. 046 iter 2 가 시드 실패
   (`.qf-m-screen .nth(N).scrollIntoViewIfNeeded()` → element not visible
   timeout) 한 채 종료. 046 의 모바일 visual coverage 매트릭스가 broken.
   (`docs/visual-regression-broken-baselines.md` B 항)
3. `TODO(task-048-follow-vrs-call-rule)` — **visual-regression-scanner
   agent 가 044~047 에서 0/15 (0%) 호출됨**. 045 FINAL REPORT 자기진단:
   "Agent tool 미노출". task contract 에 호출 의무가 mechanical check 로
   박혀있지 않아 누락이 보고에 안 잡혔다.
   (`docs/audits/visual-regression-agent-audit.md`)

이번 task 는 자율 메가 loop **이 아닌** 일반 task contract — 위 3건의
검증/안정성 부채를 청산한다. parity score 매트릭스 / 새 feature 안 다룸.

**시작 기점**: main = `6b40d3a` (048 머지 후).
**환경 확인 (UNDERSTAND)**: prod (`https://qufox.com`) 200, Docker 24.0.2,
`apps/web/dist` 존재 — baseline 시드는 prod 기준으로 수행.

## 결함 → 조치 매핑

| #   | 부채                            | 조치                                                                 | chunk |
| --- | ------------------------------- | -------------------------------------------------------------------- | ----- |
| 1   | real app routes 무시드 (구조적) | real-app visual baseline 도입                                        | A     |
| 2   | mobile-046 8 baseline 부재      | 시드 전략 재설계 (test-side, DS 4파일 unchanged)                     | B     |
| 3   | VRS 호출 0/15                   | task contract 의 mechanical step 으로 승격 + 이 task 에서 실제 spawn | C     |

## Scope (IN)

### A. Real-app visual baseline 도입 (구조적 fix)

DS mockup 이 아니라 **실제 렌더된 앱 route** 를 screenshot baseline 에
추가한다. 048 chunk B 의 numeric height assertion 위에 픽셀 baseline 을
얹어, height collapse 뿐 아니라 색/요소누락/layout shift 도 잡는다.

**신규**: `apps/web/e2e/visual/real-app-baseline.e2e.ts`

- **익명 접근 가능 surface** (fixture 불필요, prod 직접 hit):
  - `/login`, `/signup`
  - `/` → /login redirect 후 LoginPage (AppLayout 통과 검증)
  - `/discover` (익명) → redirect 표면
  - `/invite/__nonexistent__` (익명 invalid invite 표면)
- `toHaveScreenshot('real-<name>.png', { maxDiffPixelRatio: 0.02, fullPage })`
- 시드 환경: prod (`--project=prod`) 만. dev (vite HMR) 금지 (config 명시 따름)
- **인증 필요 surface (authenticated shell/channel/dm)** 는 fixture
  workspace 시드가 필요 → `TODO(task-049-follow-auth-baseline)` 로 분리.
  본 task 는 익명 표면으로 "AppLayout 트리가 실제 렌더된다" 를 baseline 화.

**검증**:

- 새 baseline snapshot commit (`real-*.png`)
- prod 기준 e2e visual run 통과
- ErrorBoundary wrapper `<div>` 회귀 시뮬 시 numeric(chunk B)+pixel(A)
  이중 fail 하는지 manual 1회 (결과 PR.md 기록)

### B. mobile-046 broken baseline 8개 정정

`.qf-m-screen .nth(N).scrollIntoViewIfNeeded()` 가 element-not-visible
로 timeout 하는 시드 실패를 test-side 전략 재설계로 해소.

**제약**: DS 4파일 (`apps/web/public/design-system/{tokens,components,
mobile,index}.{css,html}`) **수정 금지** (메모리 `feedback_design_system_
source_of_truth`). anchor id 추가 불가 → test-side 만으로 해결.

**전략 후보** (UNDERSTAND repro 결과로 확정):

- `page.evaluate((n) => document.querySelectorAll('.qf-m-screen')[n]
.scrollIntoView({block:'center'}))` 직접 호출 후 `boundingBox` clip
  screenshot
- 또는 element `screenshot()` 대신 page-level `clip` 옵션으로 좌표 기반
  capture
- visibility 판정 우회: `scrollIntoViewIfNeeded` → 직접 scrollIntoView

**검증**:

- mobile-046 8 snapshot 디스크 commit (`mobile-046-*.png` × 8)
- prod 기준 e2e 8개 통과
- `docs/visual-regression-broken-baselines.md` B 항 → resolved 갱신

### C. visual-regression-scanner 호출을 mechanical contract step 으로 승격

**작업**:

- task contract 템플릿(또는 본 task 의 AC)에 "visual-regression-scanner
  호출 ≥ 1회" 를 verifiable check 로 명시
- `docs/audits/visual-regression-agent-audit.md` Deferred 의
  `TODO(task-048-follow-vrs-call-rule)` → resolved 갱신
- **이 task 에서 실제로 visual-regression-scanner subagent 를 spawn** —
  048 audit 가 지적한 "Agent tool 미노출" 이 현 세션에서 해소됐음을
  실증 (transcript 요약 PR.md 기록)

**검증**:

- VRS subagent 1회 이상 실제 spawn (요약 PR.md 기록)
- audit 문서 Deferred 갱신 commit

### D. CI visual e2e project 스코핑 (UNDERSTAND 단계 발견 — latent 회귀)

**발견 (scope 확장)**: 048 chunk D 가 baseURL 분기용으로 local-dev /
local-dist / prod 3 project 를 추가했는데, `e2e.yml` 과 `run-e2e.sh` 가
project filter 없이 `playwright test` 를 돌린다. 결과적으로 **모든
테스트가 4 project 로 4× 실행**되고, visual snapshot baseline 은
`-chromium-linux` 한 벌만 존재하므로 나머지 3 project (local-dev /
local-dist / prod) 에서 **"snapshot doesn't exist" 로 전부 fail**.
task-049 UNDERSTAND 에서 prod 기준 실측 (`desktop · shell` → 1 passed /
3 failed) 으로 확정. 즉 048 이 visual layer 를 보강하면서 동시에 visual
e2e 를 CI 에서 red 로 만든 latent 회귀. "검증이 실제로 통과하지 않는"
부채라 049 scope 에 포함.

**작업**:

- `.github/workflows/e2e.yml`: `playwright test` → `--project=chromium`
- `scripts/run-e2e.sh`: 기본 `--project=${PLAYWRIGHT_PROJECT:-chromium}`,
  reseed 시 `PLAYWRIGHT_PROJECT=prod` override 가능
- `apps/web/playwright.config.ts`: CI 단일 chromium 실행 + prod/local-dist
  는 reseed 전용 정책 주석화. reseed 도 `--project=chromium` +
  `PLAYWRIGHT_BASE_URL=https://qufox.com` 조합으로 baseline 접미사를
  `-chromium-linux` 로 통일 (project 이름 = snapshot 접미사)

**검증**:

- `--project=chromium` + prod 로 visual(기존 8 + 신규 3 + mobile-046 8) +
  layout 7 전체 green (no `--update`)
- e2e.yml / run-e2e.sh / config diff

## Scope (OUT)

- 브랜치 정리 (101 feat/fix 전부 develop 머지됨, 메모리
  `feedback_retain_feature_branches` — 사용자가 별도 batch 처리)
- parity score 매트릭스 / 새 dim / 새 feature
- DS 4파일 수정
- 인증 필요 real-app surface baseline → `TODO(task-049-follow-auth-baseline)`
- 047 carry-over HIGH-047-A/B, MED 5 (stability 무관, 별도 task)
- Playwright framework 전면 개편

## Acceptance Criteria (mechanical)

- `pnpm verify` green (원문 첨부)
- **A**: `apps/web/e2e/visual/real-app-baseline.e2e.ts` 존재 + `real-*.png`
  baseline commit + prod e2e 통과
- **B**: `mobile-046-*.png` × 8 디스크 commit + prod e2e 8개 통과 +
  broken-baselines 문서 B 항 resolved 갱신
- **C**: VRS subagent 1회 이상 spawn (PR.md 기록) + agent-audit 문서
  Deferred 갱신
- **D**: e2e.yml + run-e2e.sh `--project=chromium` 스코핑 + config 정책
  주석 + `--project=chromium`/prod 전체 visual+layout green (no --update)
- DS 4파일 untouched (`git diff --stat` 0)
- 3 artefacts: `049-*.md`, `049-*.PR.md`, `049-*.review.md`
- 1 eval: `evals/tasks/059-verification-stability-debt.yaml`
- Reviewer subagent 실제 spawn + transcript token 기록
- 직접 develop merge → main auto-promote (메모리 `feedback_auto_promote_to_main`)
- `.deploy/audit.jsonl` (`/volume2/dockers/qufox-deploy/.deploy/`) last
  entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- Pane 1 auto-forward (메모리 `feedback_pane0_auto_forward_report`)
- FINAL REPORT 자동 출력: develop/main SHA + exitCode + /readyz + idle +
  wall clock / chunk A~C 산출물 표 / 새 baseline 목록 / mobile-046 시드
  전략 노트 / VRS spawn 요약 / Deferred TODO

## Non-goals

- 텍스트 parity score 추가 상승
- 음성/영상 (별도 프런티어 task)

## Risks

- prod 기준 시드라 prod 표면 변화 시 baseline drift → maxDiffPixelRatio
  0.02 흡수, 의도 변경은 `--update-snapshots` 명시 commit
- mobile-046 의 DS visibility 한계가 test-side 로 안 풀릴 경우 → element
  좌표 clip 폴백, 그래도 안 되면 broken 명시 유지 + 사유 갱신 (정직)
- Docker Playwright 의 prod hit 가 네트워크 의존 → retries 2 (CI)
