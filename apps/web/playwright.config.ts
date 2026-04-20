import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';

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
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
