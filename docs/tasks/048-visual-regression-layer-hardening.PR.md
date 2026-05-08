# PR — Task 048: Visual Regression Layer Hardening (Process Fix)

**Branch**: `feat/task-048-visual-regression-hardening`
**Base**: `develop` ← `main` `23492be`
**Type**: process fix + 검증 layer 보강 (자율 메가 loop 아님)
**Score 매트릭스**: N/A

## Summary

047 iter 7 의 ErrorBoundary 회귀 (정상 path 가 plain `<div>` 로 children
wrap → AppLayout flex 흐름 끊김 → 화면 전체 collapse) 가 사용자 신고로
발견된 사건의 process 결함을 정밀 조사하고 visual regression layer 를
보강합니다. 이번 변경 후 동일 패턴이 자동 차단됩니다.

핵심 결함 4 가지를 식별 + 모두 수정:

1. **Baseline coverage gap**: 기존 19 surface 가 모두 DS mockup
   (`/design-system/index.html`) 한정, real app routes 무시드. 결과:
   ErrorBoundary 같은 Routes/AppLayout 트리 회귀 검출 불가능.
2. **046 mobile-046 baseline 시드 누락**: 8 PNG 가 디스크에 존재하지
   않음 (046 iter 2 가 시드 단계 검증 안 한 채 task 종료).
3. **VRS 호출 누락**: 044~047 mega-loop 의 15 iteration 중 VRS subagent
   호출 0 회 (0%, 045 FINAL REPORT "Agent tool 미노출" 자기진단).
4. **dev↔prod 환경 차이**: Playwright config 가 dev (vite HMR) 전제,
   prod-equivalent dist preview 와 prod URL 이 분리 안 됨 → ErrorBoundary
   같은 회귀가 dev HMR overlay 에 가려져 false negative 가능.

## Changeset

| File                                                         | 종류 | 변경                                                                                                                                |
| ------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/playwright.config.ts`                              | M    | `local-dev` / `local-dist` / `prod` / `chromium` 4 project 분리 + `PLAYWRIGHT_BASE_URL` env 우선 + dev↔prod 환경 차이 표 docstring |
| `apps/web/e2e/layout/app-layout-height.e2e.ts`               | A    | 7 anonymous surface × `<main>` boundingBox.height ≥ viewport × 0.95 검증                                                            |
| `.claude/agents/visual-regression-scanner.md`                | M    | 호출 의무 강화 ("반드시 호출 / 누락 = BLOCKER") + prod baseline 시드 강제 + DS-mockup-only 한계 명시 + DS 4파일 md5 검증 의무       |
| `docs/visual-regression-broken-baselines.md`                 | A    | reseed 결과 (8 byte-identical) + broken 8 (mobile-046) + real app coverage gap                                                      |
| `docs/audits/visual-regression-agent-audit.md`               | A    | 044~047 iter × VRS 호출 표 (0/15, 0%) + 원인 분석 4 + 강화 후 description                                                           |
| `docs/tasks/048-visual-regression-layer-hardening.md`        | M    | progress log 업데이트                                                                                                               |
| `docs/tasks/048-visual-regression-layer-hardening.PR.md`     | A    | 본 문서                                                                                                                             |
| `docs/tasks/048-visual-regression-layer-hardening.review.md` | A    | reviewer subagent transcript 요약                                                                                                   |
| `evals/tasks/058-visual-regression-hardening.yaml`           | A    | DoD 9개 mechanical check                                                                                                            |

## Reseed 결과 (chunk A)

기준: `https://qufox.com` prod (main `23492be`), playwright docker
`mcr.microsoft.com/playwright:v1.48.2-jammy --network host`.

| surface                  | 기존 md5 (045/046 시드) | reseed md5 (prod) | drift     |
| ------------------------ | ----------------------- | ----------------- | --------- |
| desktop-shell            | `84d7e148...`           | `84d7e148...`     | 0% (동일) |
| desktop-channel-empty    | `eab5b3a3...`           | `eab5b3a3...`     | 0%        |
| desktop-dm-list          | `2028e760...`           | `2028e760...`     | 0%        |
| desktop-dm-thread        | `73df1b38...`           | `73df1b38...`     | 0%        |
| desktop-settings         | `ebbdb791...`           | `ebbdb791...`     | 0%        |
| desktop-discover         | `03d6bcfb...`           | `03d6bcfb...`     | 0%        |
| desktop-channel-settings | `d2b76777...`           | `d2b76777...`     | 0%        |
| mobile-mobile-overview   | `aaae49cd...`           | `aaae49cd...`     | 0%        |

기존 baseline 은 prod 와 일치 (DS 040 부터 untouched 라 dev↔prod drift
없음) → broken 아님. 단 DS-mockup-only 라 real app 회귀 검출 불가능.

## Broken baseline 식별 표 (chunk A)

| surface                     | nth | 시드 결과                      | 상태       |
| --------------------------- | --- | ------------------------------ | ---------- |
| mobile-046-discover         | 0   | element-not-visible 100+ retry | **broken** |
| mobile-046-workspace-create | 1   | 동일                           | **broken** |
| mobile-046-channel-composer | 2   | 동일                           | **broken** |
| mobile-046-members          | 3   | 동일                           | **broken** |
| mobile-046-thread           | 6   | 동일                           | **broken** |
| mobile-046-dm-list          | 7   | 동일                           | **broken** |
| mobile-046-dm-thread        | 8   | 동일                           | **broken** |
| mobile-046-pinned-panel     | 4   | 동일                           | **broken** |

**원인 추정**: DS mobile 페이지의 `qf-m-screen` 13 frame stack 에서
nth-indexed 요소가 viewport `375×700` 에 들어와도 visibility 판정 미충족.
정정 = 별도 task → `TODO(task-048-follow-mobile-046-broken)`.

## Agent 호출 누락 표 (chunk C)

| task / iter       | UI 변경                  | VRS 의무 | VRS 호출           |
| ----------------- | ------------------------ | -------- | ------------------ |
| 044 iter 1        | YES                      | YES      | **NO**             |
| 044 iter 2        | YES                      | YES      | **NO**             |
| 044 iter 3        | YES                      | YES      | **NO**             |
| 045 iter 0        | YES (baseline 시드)      | YES      | **NO**             |
| 045 iter 1~8      | YES                      | YES      | **NO** (8)         |
| 046 iter 1~3      | YES                      | YES      | **NO** (3)         |
| 047 iter 1~6      | YES                      | YES      | **NO** (6)         |
| **047 iter 7**    | YES (ErrorBoundary 추가) | YES      | **NO** (회귀 발생) |
| **048 (본 task)** | YES (검증 layer)         | YES      | **YES (1회)**      |

이전 0/15 (0%) → 048 부터 의무 1회/이벤트 시작.

## Playwright config diff + 환경 차이 정리 (chunk D)

```diff
-const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
+const ENV_BASE_URL = process.env.PLAYWRIGHT_BASE_URL;
+const DEFAULT_LOCAL_BASE_URL = 'http://localhost:5173';
+const DEFAULT_PROD_BASE_URL = 'https://qufox.com';
 ...
   projects: [
+    { name: 'local-dev',  use: { ...devices['Desktop Chrome'], baseURL: ENV_BASE_URL ?? DEFAULT_LOCAL_BASE_URL } },
+    { name: 'local-dist', use: { ...devices['Desktop Chrome'], baseURL: ENV_BASE_URL ?? DEFAULT_LOCAL_BASE_URL } },
+    { name: 'prod',       use: { ...devices['Desktop Chrome'], baseURL: ENV_BASE_URL ?? DEFAULT_PROD_BASE_URL } },
     { name: 'chromium',   use: { ...devices['Desktop Chrome'] } },
   ],
```

| layer         | dev (vite)              | dist preview                             | prod (qufox.com)                 |
| ------------- | ----------------------- | ---------------------------------------- | -------------------------------- |
| bundler       | esbuild HMR             | rollup prod                              | rollup prod (CI built)           |
| API URL       | proxy → :3001           | `VITE_API_URL=/api` (Dockerfile default) | `/api` → nginx-proxy → qufox-api |
| asset 경로    | `/src/...` (HMR)        | `/assets/<hash>.js`                      | 동일                             |
| env preset    | NODE_ENV=development    | NODE_ENV=production                      | 동일                             |
| ErrorBoundary | HMR overlay 무력화 가능 | prod minify (회귀 표면화)                | 동일                             |

## 회귀 e2e 결과 (chunk B)

| surface     | URL                       | --project=prod 결과 | wall clock |
| ----------- | ------------------------- | ------------------- | ---------- |
| shell-empty | `/`                       | ✓ pass              | 2.6s       |
| channel     | `/w/qufox-team/general`   | ✓ pass              | 3.2s       |
| dm-list     | `/dm`                     | ✓ pass              | 3.0s       |
| dm-thread   | `/dm/00000000-...`        | ✓ pass              | 3.2s       |
| profile     | `/me/profile`             | ✓ pass              | 1.9s       |
| settings    | `/settings/notifications` | ✓ pass              | 2.0s       |
| discover    | `/discover`               | ✓ pass              | 1.9s       |

7 passed in 7.8s.

## ErrorBoundary fail 시뮬 검증 결과

| step                                                   | 결과                                           |
| ------------------------------------------------------ | ---------------------------------------------- |
| ErrorBoundary `Fragment` → `<div>` 일시 변경           | applied                                        |
| `pnpm --filter @qufox/web build`                       | ✓ 6.33s                                        |
| `pnpm preview --port 5174` 기동                        | ✓ 200                                          |
| layout e2e `--project=local-dist baseURL=:5174`        | **7 fail** (`main height 494.40625px < 684px`) |
| ErrorBoundary 원복 (Fragment)                          | applied                                        |
| md5 검증 vs `/tmp/task-048-errorboundary-original.tsx` | ✓ `bff41dcd...` byte-identical                 |
| dist 재빌드                                            | ✓ 7.09s                                        |
| layout e2e `--project=prod` 재실행                     | ✓ 7 pass                                       |

회귀 패턴 (`<div>` wrapper) 시 7 surface 모두 명확한 height assertion
fail 메시지 출력 → 047 iter 7 패턴 자동 차단 검증 완료.

## DS Files Untouched

```
8608cbaa49d605b17c6063ee6bff821b  apps/web/public/design-system/tokens.css
45890a91e3bb4880c63697a7c39f2db9  apps/web/public/design-system/components.css
64bd048551d77a9d199163d6751ba668  apps/web/public/design-system/mobile.css
388668133693a5ab6f391d23554db252  apps/web/public/design-system/icons.css
```

`.task-040-ds-baseline.txt` 와 byte-identical (4/4).

## Reviewer subagent

- **agentId**: `a05d2be4b32de1f26`
- **transcript tokens**: 32,895
- **tool uses**: 15
- **duration**: 72.5s
- **결과**: 모든 layer PASS, BLOCKER/HIGH 없음. 1건 정정 (DS 4파일 표기
  `index.css|.html` → `icons.css`) 반영 완료.

## Verify

- `pnpm verify` exit code: **0**
- 19/19 tasks successful (16 cached, 3 new — visual baseline reseed 결과
  byte-identical 이라 git diff 없음)
- errors 0 / warnings 322 (기존 carry-over, 048 신규 0건)

## Deferred (TODO)

- `TODO(task-048-follow-mobile-046-broken)` — mobile-046 8 baseline
  시드 전략 재설계 (DS anchor id 추가 또는 element handle 직접 capture)
- `TODO(task-048-follow-real-app-baseline)` — real app routes 의 visual
  snapshot baseline 추가 (login/signup/invite/profile-anon/dm-anon 등)
- `TODO(task-048-follow-vrs-call-rule)` — task contract template 의
  Acceptance Criteria 에 "VRS 호출 ≥ 1" mechanical check 추가
- `TODO(task-048-follow-vrs-baseline-policy)` — PR.md template 의 첫
  row 로 baseline 시드 environment 강제 표기
- `TODO(task-048-follow-react-19)` — react-router 6 → 7 / Suspense 동작
  변동 가능성에 따라 본 layout e2e 재검증 (별도 task)
- `TODO(task-048-follow-mobile-layout-e2e)` — viewport 375×667 의
  layout regression e2e (mobile DM/channel/topbar)
