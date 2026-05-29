import { test, expect } from '@playwright/test';

/**
 * task-049 chunk A — real-app visual baseline.
 *
 * **부채 (task-048 deferred, `docs/visual-regression-broken-baselines.md` C 항)**:
 * 045/046 의 visual baseline 19개는 전부 `/design-system/index.html`
 * (정적 DS mockup) 만 캡처했고, `apps/web/src/App.tsx` 의 AppLayout /
 * Routes / ErrorBoundary 트리는 visual baseline 의 검증 대상이 **한 번도
 * 아니었다**. 그래서 047 iter 7 의 ErrorBoundary 회귀 (정상 path 가
 * `<div>` 로 children wrap → AppLayout flex/height 흐름 끊김 → 화면 전체
 * collapse) 가 snapshot 으로 안 잡혔다.
 *
 * 048 chunk B 의 `app-layout-height.e2e.ts` 가 root container height 를
 * **numeric** 으로 검증한다면, 본 spec 은 **실제 렌더된 앱 route 의
 * 픽셀 baseline** 을 잡아 height collapse 뿐 아니라 색 / 요소 누락 /
 * layout shift 도 검출한다. 둘은 상호 보완 — numeric 은 threshold 무관
 * 강한 신호, pixel 은 넓은 회귀 표면.
 *
 * **익명 접근 surface** (fixture / 인증 불필요 → prod 직접 hit):
 * - `/login`  → LoginPage   (실제 form + AppLayout 트리)
 * - `/signup` → SignupPage  (실제 form)
 * - `/invite/__nonexistent__` → InviteAcceptPage (invalid invite 표면)
 *
 * 인증 필요 surface (authenticated shell / channel / dm) 는 fixture
 * workspace 시드가 필요 → `TODO(task-049-follow-auth-baseline)` 로 분리.
 * 본 spec 은 "AppLayout 트리가 실제로 렌더된다" 를 익명 표면으로 baseline 화.
 *
 * **시드 환경**: prod (`--project=prod`, `https://qufox.com`) 또는
 * dist preview (`--project=local-dist`) 만. dev (vite HMR) 는
 * ErrorBoundary 무력화 / hydration 차이로 false negative → 금지
 * (`playwright.config.ts` chunk D 노트 참조).
 *
 * **threshold**: maxDiffPixelRatio 0.02 (2%) — 폰트 antialias / cursor
 * blink 흡수. 실제 회귀는 그보다 훨씬 큰 diff.
 *
 * **갱신 정책**: 의도된 UI 변경 시 `--update-snapshots` 명시 commit.
 */

const THRESHOLD = Number(process.env.VISUAL_BASELINE_THRESHOLD ?? 0.02);
const VIEWPORT_DESKTOP = { width: 1280, height: 720 };

test.setTimeout(60_000);

type Surface = {
  name: string;
  url: string;
  /** screenshot 직전 안정화를 위해 기다릴 셀렉터 (실제 페이지 렌더 신호). */
  readySelector: string;
  description: string;
};

const SURFACES: Surface[] = [
  {
    name: 'login',
    url: '/login',
    readySelector: '[data-testid="login-submit"]',
    description: 'LoginPage — 실제 form + AppLayout 트리',
  },
  {
    name: 'signup',
    url: '/signup',
    readySelector: '[data-testid="signup-submit"]',
    description: 'SignupPage — 실제 form',
  },
  {
    name: 'invite-invalid',
    url: '/invite/__nonexistent__',
    readySelector: '[data-testid="invite-invalid"]',
    description: 'InviteAcceptPage — invalid invite 표면 (API resolve 후)',
  },
];

test.describe('task-049 chunk A — real-app visual baseline (anonymous)', () => {
  for (const surface of SURFACES) {
    test(`real · ${surface.name} (${surface.description})`, async ({ page }) => {
      await page.setViewportSize(VIEWPORT_DESKTOP);
      await page.addInitScript(() => {
        try {
          document.documentElement.setAttribute('data-theme', 'dark');
        } catch {
          /* no-op */
        }
      });
      await page.goto(surface.url, { waitUntil: 'load' });
      // 실제 페이지 렌더 신호 대기 — auth-check 스피너 / invite API resolve
      // 가 끝나 안정 상태에 도달했는지 보장.
      await page.locator(surface.readySelector).first().waitFor({
        state: 'visible',
        timeout: 15_000,
      });
      await page.evaluate(() => (document as Document & { fonts?: FontFaceSet }).fonts?.ready);
      // 잔여 transition / cursor blink settle.
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`real-${surface.name}.png`, {
        maxDiffPixelRatio: THRESHOLD,
        fullPage: true,
      });
    });
  }
});
