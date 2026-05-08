import { defineConfig, devices } from '@playwright/test';

/**
 * task-048 chunk D — env 별 baseURL 명시.
 *
 * 047 iter 7 의 ErrorBoundary 회귀가 dev (vite HMR) 시드 baseline 으로
 * 안 잡힌 한 원인이 dev↔prod 의 hydration / asset 경로 / env 차이.
 * 이번 task 부터는 시드 환경을 명시적으로 분리:
 *
 * - **local-dev**  → `http://localhost:5173`           (vite, HMR, false-negative 위험 — visual baseline 시드 금지)
 * - **local-dist** → `http://localhost:5173`           (`pnpm --filter @qufox/web preview` — dist build, prod-equivalent)
 * - **prod**       → `https://qufox.com`               (실제 배포, 가장 강함, baseline 시드 권장 환경)
 *
 * 사용법:
 *
 *   # baseline reseed (prod, 권장)
 *   cd apps/web && PLAYWRIGHT_BASE_URL=https://qufox.com pnpm exec playwright test --project=prod --update-snapshots
 *
 *   # local dist preview reseed (개발자 머신)
 *   cd apps/web && pnpm build && pnpm preview &
 *   cd apps/web && pnpm exec playwright test --project=local-dist --update-snapshots
 *
 *   # PR 검증 (dev — visual-baseline / layout 시드 안 함, smoke / contract 만)
 *   cd apps/web && pnpm exec playwright test --project=local-dev
 *
 * `PLAYWRIGHT_BASE_URL` env 가 명시되면 그게 우선 — CI matrix 에서
 * 환경 별 baseURL 을 한 줄로 override.
 *
 * **dev↔prod 환경 차이 grep 결과** (task-048 chunk D 의 environment
 * audit):
 *
 * | layer            | dev (vite)              | dist preview               | prod (qufox.com)             |
 * | ---------------- | ----------------------- | -------------------------- | ---------------------------- |
 * | bundler          | esbuild HMR             | rollup prod                | rollup prod (CI built)       |
 * | API URL          | proxy → :3001 (vite)    | `VITE_API_URL=/api` (Dockerfile default) | `/api` → nginx-proxy → qufox-api |
 * | asset 경로        | `/src/...` (HMR)        | `/assets/<hash>.js`        | `/assets/<hash>.js`          |
 * | env preset       | NODE_ENV=development    | NODE_ENV=production        | NODE_ENV=production          |
 * | ErrorBoundary    | HMR overlay 가 무력화 가능 | prod minify (정상 표면화)   | prod minify (정상 표면화)     |
 * | hydration        | 즉시                     | chunk lazy load            | chunk lazy load              |
 *
 * dev 의 `ErrorBoundary 무력화 가능` 이 047 iter 7 회귀의 false
 * negative 후보 — wrapper `<div>` 회귀가 dev HMR overlay 에 가려졌을
 * 수 있음. dist/prod 에서는 정상 path 로 children 을 prod minify 후
 * 렌더 → wrapper `<div>` 의 height collapse 가 그대로 표면화. 이
 * 차이는 048 chunk B 의 `app-layout-height.e2e.ts` 가
 * `--project=prod` 로 돌면 즉시 잡힘.
 */

const ENV_BASE_URL = process.env.PLAYWRIGHT_BASE_URL;
const DEFAULT_LOCAL_BASE_URL = 'http://localhost:5173';
const DEFAULT_PROD_BASE_URL = 'https://qufox.com';

// Parallelization — each test creates unique slugs/emails/usernames via
// `Date.now()+random` so DB-level isolation is not required; tests behave
// like independent API clients. Full schema-per-worker isolation (spinning
// a separate NestApplication per worker) is tracked as TODO(task-018) for
// when we need hard-isolated fixtures (e.g. global Redis keys).
const WORKERS = Number(process.env.PLAYWRIGHT_WORKERS ?? 4);

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts/,
  fullyParallel: true,
  workers: WORKERS,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    // Default — env override > local-dev fallback.
    baseURL: ENV_BASE_URL ?? DEFAULT_LOCAL_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    // 048 chunk D: env 별 baseURL 분리 — visual-regression-scanner
    // agent 가 prod / local-dist 만 시드하도록 강제. local-dev 는
    // smoke / contract 한정.
    {
      name: 'local-dev',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: ENV_BASE_URL ?? DEFAULT_LOCAL_BASE_URL,
      },
    },
    {
      name: 'local-dist',
      use: {
        ...devices['Desktop Chrome'],
        // `pnpm --filter @qufox/web preview` 도 5173 사용 — dev 와 같은
        // 포트지만 dist build 기준이라 preview 가 떠 있을 때만 동작.
        baseURL: ENV_BASE_URL ?? DEFAULT_LOCAL_BASE_URL,
      },
    },
    {
      name: 'prod',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: ENV_BASE_URL ?? DEFAULT_PROD_BASE_URL,
      },
    },
    // 기존 단일 chromium project 유지 (default project) — 048 이후의
    // task 가 `--project=prod` 등으로 명시 지정하지 않아도 기존 e2e
    // workflow (smoke / auth / shell ...) 가 깨지지 않도록.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
