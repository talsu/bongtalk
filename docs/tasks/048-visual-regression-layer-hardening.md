# Task 048 — Visual Regression Layer Hardening (Process Fix)

## Context

047 iter 7 의 ErrorBoundary 회귀 (정상 path 가 plain `<div>` 로 children
wrap → AppLayout flex/height 흐름 끊김 → 화면 전체가 workspace rail
아이콘 stack 높이로 줄어드는 prod BLOCKER) 가 사용자 직접 신고로 발견됐다.
자율 메가 loop 의 visual regression layer 가 못 잡은 process 결함이다.

이번 task 는 자율 메가 loop **이 아닌** 일반 task contract — process
결함 정밀 조사 + 검증 layer 보강. score 매트릭스 안 다룸.

**Hot-fix 적용 후 상태**:

- main = `23492be` (ErrorBoundary wrapper `<div>` → `Fragment` 교체)
- 회귀 spec: `ErrorBoundary.spec.ts` 에 정적 source assertion 추가
- /api/readyz 200, db/redis/outbox ok

**복원지점** (이미 확보):

- Tag: `v0.47-restore-point` (push 됨)
- Branch: `restore-point/main-23492be` (push 됨)
- 둘 다 `23492be` 가리킴
- 044~046 의 v0.43~v0.46 도 살아있음

**시작 기점**: main = `23492be` (hot-fix 직후).

## 결함 가설 (UNDERSTAND 단계 검증)

자율 loop 가 layout 회귀를 못 잡은 이유 후보:

1. **Baseline 시드 시점이 broken 상태**: 045 iter 0 (또는 046 iter 2) 의
   baseline 시드 자체가 broken 화면에서 캡처됐다면 047 iter 7 변경도
   baseline 과 일치 → "regression 없음" 오판
2. **Visual-regression-scanner agent 호출 누락**: 044~047 의 일부
   iteration 에서 agent 호출이 안 됐을 가능성. agent description trigger
   가 모호해 메인 agent 가 skip 했을 수도
3. **dev↔prod 환경 차이**: baseline 이 dev server (Vite HMR) 에서
   캡처되고 prod 는 nginx + dist build → hydration 결과 다름. 같은
   layout regression 이 dev 에서 안 보일 수 있음
4. **Playwright snapshot 의 회귀 감도 한계**: viewport 크기만 고정되고
   실제 DOM 흐름 변화 잘 못 감지. screenshot 의 픽셀 diff threshold
   가 너무 관대하면 큰 layout shift 도 통과

## Scope (IN) — 4 chunks

### A. Prod baseline 재시드 + dev baseline diff 분석

**작업**:

- 19 surface 모두 **실제 prod (https://qufox.com) 환경에서 Playwright 캡처**
  - 데스크톱 7 (shell / channel-empty / channel-with-messages / DM list /
    DM thread / settings / discover)
  - 모바일 12 (045 iter 0 의 4개 + 046 iter 2 의 8개)
- 기존 baseline (apps/web/e2e/visual/**snapshots**) 과 픽셀 diff
  - threshold 0.5% 이상 차이 = broken baseline 후보
  - diff 발견 시 file:line + 영역 추정
- broken baseline 식별 + 원인 노트 → `docs/visual-regression-broken-baselines.md`
- 새 baseline commit `chore(visual-regression): reseed baseline from prod @ 23492be`

**검증**:

- 새 baseline 위에서 e2e visual run 통과
- 기존 baseline 과의 diff 표 (broken 추정 surface 식별)

**증거**:

- `docs/visual-regression-broken-baselines.md` 존재 + broken surface list
- 새 baseline snapshot commit + git diff 19 파일 변경

### B. Root layout 회귀 e2e (AppLayout 정합 강제)

**신규**: `apps/web/e2e/layout/app-layout-height.e2e.ts`

핵심 surface 에서 root container 의 height 가 viewport 높이의 95% 이상
보장:

- shell empty (`/`)
- channel (`/w/<slug>/<channelName>`)
- DM list (`/dm`)
- DM thread (`/dm/<userId>`)
- profile (`/me/profile`)
- settings (`/settings/notifications`)
- discover (`/discover`)

각 surface 마다:

- `await page.goto(URL)`
- `const root = page.locator('#root > *').first()` 또는 AppLayout 의
  outer container
- `expect(root.boundingBox().height).toBeGreaterThan(viewport.height * 0.95)`

**ErrorBoundary 같은 wrapper 추가 시 즉시 fail 하는 e2e** — 사용자가
발견한 회귀 패턴 자동 차단.

**증거**:

- e2e 파일 존재 + 7 surface 모두 통과
- ErrorBoundary 정상 path 를 일부러 `<div>` 로 변경하면 fail 하는지
  manual 검증 후 원복 (또는 spec 안에 fail 시뮬 코멘트)

### C. Visual-regression-scanner agent audit (044~047 호출 검증)

**작업**:

- 044/045/046/047 의 다음 자료 검토:
  - `docs/tasks/0NN-iteration-N-{audit,plan}.md`
  - `docs/tasks/0NN-*.review.md`
  - 가능하면 reviewer transcript (token count 기록)
- 각 iteration 별 visual-regression-scanner 호출 여부 확인
- 호출 안 된 iteration list + 사유 추정
- `docs/audits/visual-regression-agent-audit.md` 작성

**Agent 정의 강화**: `.claude/agents/visual-regression-scanner.md`

- description trigger 강화: "UI 변경 (apps/web/src/components, features,
  shell, design-system) 후 **반드시** 호출. 호출 누락 시 BLOCKER"
- baseline 시드 환경 명시: "prod 환경 (또는 prod nginx build) 에서만
  baseline 캡처. dev server (vite HMR) 는 false negative 위험"
- 호출 의무: 각 iteration 의 UI/UX 검증 단계에 반드시 1회

**증거**:

- audit 문서 존재 + 호출 누락 표
- agent 정의 갱신 commit
- 048 자체에서는 호출 의무 적용 (A/B 청크 후 호출)

### D. Playwright config 정합 (dev↔prod 차이)

**작업**:

- `apps/web/playwright.config.ts` 검토
- baseline 시드 환경:
  - 현재: dev (Vite) 또는 prod nginx 어느 쪽인지 grep
  - 변경: prod nginx build 산출물 (`apps/web/dist`) 기준으로 통일
  - 또는 baseURL 옵션 prod (`https://qufox.com`) / local-dist
    (`apps/web/dist serve`) / local-dev (`vite dev`) 3개 project
    분리
- env / API URL / asset 경로 차이 grep + 명시
- 공통 build 흐름:
  - `pnpm --filter @qufox/web build` → `apps/web/dist`
  - `pnpm --filter @qufox/web preview` 또는 `serve apps/web/dist`
  - Playwright `baseURL` 가 preview server 가리킴

**증거**:

- playwright.config.ts diff
- 새 project / baseURL 설정 검증
- baseline 재시드 (A) 와 정합

### E. develop → main auto-promote + Pane 1 auto-forward (38번째)

표준 flow.

## Scope (OUT)

- 자율 메가 loop 패턴 (이번엔 일반 task contract)
- DS 4파일 수정
- 매트릭스 score 산정 / 새 dim 추가 (047 의 carry-over 와 무관)
- 047 의 다른 carry-over (HIGH-047-A/B, MED 5) — 별도 task (049 후보)
- 새 feature
- 모바일 production code (HIGH-047-B 도 별도 task)
- visual regression baseline 의 모든 dev↔prod 차이 정정 (이번엔 broken
  surface 만 식별, 정정은 후속)
- Playwright framework 전면 개편

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- **A 검증**:
  - 새 baseline 19 snapshot commit 존재
  - `docs/visual-regression-broken-baselines.md` 존재 + broken surface list
  - 기존 baseline 과의 diff 표 첨부
- **B 검증**:
  - `apps/web/e2e/layout/app-layout-height.e2e.ts` 존재
  - 7 surface 통과
  - ErrorBoundary 회귀 패턴 (wrapper `<div>`) 시 fail 시뮬 manual 검증
- **C 검증**:
  - `docs/audits/visual-regression-agent-audit.md` 존재 + 044~047 호출 누락 표
  - `.claude/agents/visual-regression-scanner.md` description trigger 강화 commit
  - 048 자체에서 visual-regression-scanner 호출 1회 이상 (audit log)
- **D 검증**:
  - `apps/web/playwright.config.ts` baseURL prod 또는 local-dist 명시
  - dev / dist / prod 3개 환경의 baseline 정합 노트
- DS 4파일 untouched (`git diff` 0)
- 3 artefacts: `048-*.md` (task contract), `048-*.PR.md`, `048-*.review.md`
- 1 eval: `evals/tasks/058-visual-regression-hardening.yaml`
- Reviewer subagent 실제 스폰 + transcript token 기록
- 직접 develop merge → main auto-promote
- `.deploy/audit.jsonl` (`/volume2/dockers/qufox-deploy/.deploy/`) last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 38번째**
- FINAL REPORT 자동 출력, 포함:
  - develop/main SHA + exitCode + /readyz + idle + wall clock
  - 청크 A~D 산출물 표
  - **Broken baseline 식별 표** (surface 별 diff %)
  - **Agent 호출 누락 표** (044~047 iteration 별)
  - Playwright config diff + 환경 차이 정리
  - 회귀 e2e 결과 (7 surface)
  - Deferred TODO(task-048-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 047 hot-fix merged + deployed (`23492be` main)
- 044~047 의 19 surface visual baseline 존재 (broken 가능성)
- Sub-agent 10개 (`.claude/agents/`)
- Playwright 의존성 설치 (045 iter 0 에서 시드 가정)
- 복원지점 `v0.47-restore-point` (push 됨)

## Design Decisions

### 자율 메가 loop 가 아닌 일반 task contract

이번엔 process 결함 정밀 조사 + 검증 layer 보강이라 score 매트릭스
적용 X. iteration 패턴 X. 명시 청크 단위 직진.

### Prod 환경 baseline 시드 강제

dev server (Vite HMR) ↔ prod nginx 차이는 hydration / asset 경로 /
env 다름. baseline 의 신뢰성 위해 prod 또는 prod-equivalent (preview
server with dist) 통일.

### Root layout 회귀 e2e 의 의미

ErrorBoundary 사례처럼 visual snapshot 으로는 잡기 어려운 layout
shift 가 있음. boundingBox 의 numeric 검증이 픽셀 diff 보다 직접적
회귀 감지.

### Agent 정의 강화

description trigger 가 추상적이면 메인 agent 가 호출 skip 가능. 명시
"UI 변경 후 반드시 호출" 강제. agent 자체는 hint 만 줄 수 있고 메인
agent 의 협업 패턴은 별도 강제 메커니즘 (예: task doc 의 명시 step) 도
필요.

### Broken baseline 식별 vs 정정

이번엔 broken surface **식별** 만. 정정 (실제 prod 화면이 어떻게 돼야
하는지 결정) 은 디자인 결정 포함이라 별도 task. 단 baseline 자체는
prod 현재 상태 (hot-fix 후) 로 재시드 → 향후 회귀 차단.

### 047 carry-over 와의 분리

HIGH-047-A (audit re-eval inflation), HIGH-047-B (모바일 4 production
code), MED 5 는 별도 task (049 후보). 048 은 process fix 만 집중.

## Non-goals

- 자율 메가 loop
- score 매트릭스 산정
- 047 carry-over 처리
- 새 feature
- DS 재디자인
- 모바일 production code (HIGH-047-B)
- broken baseline 의 화면 정정 (디자인 결정)
- 새 sub-agent 추가
- React 19 / 큰 의존성 변경

## Risks

- **Prod baseline 시드 시 prod 가 또 다른 회귀 보유**: 사용자 신고
  layout 외 다른 broken 이 prod 에 있을 수도 있음. 시드 전 사용자에게
  prod 화면 점검 1회 요청 권장
- **19 surface 모두 prod 캡처 시 인증 필요**: 로그인 후 surface 들이
  대부분. Playwright 가 prod 에 인증 가능한 test user 가짜 credentials
  필요. 시드 fixture 또는 dev account 활용
- **Playwright NAS 미설치 가능성**: 045 iter 0 에서 설치했다고 가정.
  아니면 `pnpm playwright install` 또는 docker compose
- **e2e flakiness**: viewport height 측정이 mobile orientation /
  address-bar collapse 에 따라 변동. 95% threshold 가 충분히 안전
- **Agent audit 자료 부족**: 044~047 의 reviewer transcript / iteration
  log 가 visual-regression-scanner 호출 흔적 기록 안 됐을 수 있음.
  부재 시 "호출 추정 X" 로 보고
- **Playwright config 변경이 기존 e2e 깸**: 19 baseline + 다른 e2e
  들 모두 새 config 위에서 통과 검증
- **Prod 환경 인증 + 실제 사용자 데이터 노출**: prod baseline 캡처 시
  특정 user account 의 실제 메시지가 snapshot 에 포함될 위험. fixture
  workspace 또는 staging 환경 필요. 단 NAS-only 라 staging 별도 X
  → fixture workspace 만 사용
- **Dist build 로 baseline 시드 충분**: 사실 prod 와 dist build 가
  동일 산출물이면 prod 직접 캡처 불필요. local-dist preview 로 충분.
  Risk 줄어듦

## Progress Log

- [x] UNDERSTAND — 045 iter 0 baseline 위치 / Playwright config /
      044~047 VRS 호출 흔적 / dev↔prod 차이 모두 식별. 핵심 결함:
      (1) 기존 baseline 19 surface 가 모두 `/design-system/index.html`
      mockup 한정, real app routes 무시드 → ErrorBoundary 회귀 검출
      불가능; (2) mobile-046 8 baseline 디스크 미존재 (046 iter 2 시드
      누락); (3) 044~047 mega-loop 어디에서도 VRS 호출 0 회 (045
      FINAL REPORT 자기진단 "Agent tool 미노출"); (4) Playwright config
      가 단일 chromium project + dev (`localhost:5173`) 전제.
- [x] PLAN — 4 chunks 직진. baseline reseed 는 prod (`https://qufox.com`)
      직접 캡처 (anonymous-accessible DS 페이지 + real app /login 기반).
- [x] SCAFFOLD — feat branch `feat/task-048-visual-regression-hardening`
      생성. 산출물 stub.
- [x] IMPLEMENT
  - A: prod reseed 결과 8 baseline 모두 byte-identical (DS 040 부터
    untouched). mobile-046 8 surface 는 시드 실패 (`.qf-m-screen.nth()`
    not visible) → broken-baselines.md.
  - B: `apps/web/e2e/layout/app-layout-height.e2e.ts` 7 surface, target
    `<main, [data-testid="app-error-boundary"]>` 의 boundingBox.height
    ≥ viewport × 0.95. `--project=prod` 7 passed in 7.8s. fail-sim:
    ErrorBoundary `<div>` wrap 일시 적용 + dist build + local-dist
    e2e → 7 surface 모두 `main height 494.40625px < 684px` 로 fail
    확인 후 원복 (md5 일치).
  - C: VRS audit doc + agent 정의 강화. 048 자체에서 VRS subagent
    (general-purpose 에 VRS persona 부여) 1회 스폰, transcript
    32895 tokens, agent id `a05d2be4b32de1f26`. 모든 layer PASS 보고.
  - D: playwright.config.ts 에 `local-dev` / `local-dist` / `prod` /
    `chromium` 4 project 명시. baseURL 은 `PLAYWRIGHT_BASE_URL` env
    우선. dev↔prod 환경 차이 표 docstring 에 박음.
- [x] VERIFY — `pnpm verify` exit 0 (errors 0, warnings only, 19/19
      tasks). DS 4파일 md5 untouched. layout e2e prod 7 pass. fail-sim
      검증 완료 후 ErrorBoundary 원복 byte-identical.
- [x] OBSERVE — broken-baseline 표 8 broken (mobile-046) + 0 drift
      (existing 8 byte-identical). agent 호출 누락 표 0/15 (0%) 044~047.
      playwright config diff 첨부.
- [x] REFACTOR — e2e spec 의 측정 대상 `#root > *` → `<main>` 으로
      교정 (47 회귀가 inner content 에서 발생, outer AppLayout 은
      `height:100%` 로 viewport 항상 채우기 때문).
- [x] REPORT — 본 progress log + 048-_.PR.md + 048-_.review.md +
      FINAL REPORT pane 0 auto-printed + pane 1 auto-forward 38번째.
