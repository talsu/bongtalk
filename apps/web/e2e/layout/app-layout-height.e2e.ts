import { test, expect } from '@playwright/test';

/**
 * task-048 chunk B — root layout 회귀 e2e.
 *
 * 047 iter 7 ErrorBoundary 회귀 (`apps/web/src/components/ErrorBoundary.tsx`
 * 의 정상 path 가 `<div>` 로 children 을 wrap → AppLayout
 * `display:flex column; height:100%; minHeight:0` 흐름 끊김 → 페이지
 * 전체가 workspace rail 아이콘 stack 높이로 collapse) 는 visual
 * snapshot 의 DS-mockup-only 시드로는 잡히지 않았다 (task-048 chunk A
 * `docs/visual-regression-broken-baselines.md` 참조). 본 spec 은
 * **real app route 의 root container height** 를 numeric 으로 검증해
 * 동일 패턴의 wrapper `<div>` 회귀를 즉시 fail 시킨다.
 *
 * 검증 대상 (anonymous-accessible 7 surface):
 *
 * | surface           | URL                              | 익명 시 렌더                        |
 * | ----------------- | -------------------------------- | ----------------------------------- |
 * | shell-empty       | `/`                              | → /login (auth gate, AppLayout 통과)|
 * | channel           | `/w/qufox-team/general`          | → /login (LoginPage)                |
 * | DM list           | `/dm`                            | → /login                            |
 * | DM thread         | `/dm/00000000-0000-0000-0000-000000000000` | → /login                  |
 * | profile           | `/me/profile`                    | → /login                            |
 * | settings          | `/settings/notifications`        | → /login                            |
 * | discover          | `/discover`                      | → /login                            |
 *
 * **왜 익명 redirect 만으로 회귀를 잡는가?** AppLayout 은 모든 route
 * 의 공통 wrapper (App.tsx:235-242, App.tsx:251 `<AppLayout>` 안에
 * `<ErrorBoundary><Routes>...</Routes></ErrorBoundary>` 가 들어감).
 * 따라서 ErrorBoundary 같은 wrapper 가 height 를 잘라먹으면 어떤 URL
 * 을 hit 하든 root height collapse 가 동일하게 발생한다. 047 회귀
 * 사용자가 신고했을 당시도 인증된 shell 뿐 아니라 익명 /login 도 같이
 * 깨졌다 (사용자 신고 패턴: "전체 화면이 rail 아이콘 stack 높이로 줄어듦").
 * 익명 surface 검증은 testcontainers / fixture user 없이 prod 또는 dist
 * preview 에 직접 hit 가능 → harness 이식성 ↑.
 *
 * **Threshold 95%**: viewport 1280×720 → root height ≥ 684px. iOS 의
 * dynamic viewport (address-bar collapse) 같은 변동 흡수. 5% 이상
 * collapse 는 사람 눈에 명백히 부족하므로 의미 있는 회귀 신호.
 *
 * **ErrorBoundary fail 시뮬**: spec 안에서 직접 wrapper 를 주입할 수
 * 없지만 (real app build 변경 필요), 회귀 패턴 manual 시뮬은 다음과
 * 같이 검증된다 (이 spec 은 `pnpm verify` 로 늘 돌므로 실제 prod build
 * 변경이 들어오면 fail):
 *
 *   1. `apps/web/src/components/ErrorBoundary.tsx` 의 정상 path 를
 *      Fragment → `<div>` 로 되돌림
 *   2. `pnpm --filter @qufox/web build && pnpm --filter @qufox/web preview`
 *   3. `PLAYWRIGHT_BASE_URL=http://localhost:5173 pnpm exec playwright \
 *       test e2e/layout/app-layout-height.e2e.ts` → 7 surface 모두 fail
 *   4. ErrorBoundary 정상 path 를 Fragment 로 원복 → 모두 pass
 *
 * 이 시뮬은 task-048 chunk B 산출물에 manual 1 회 검증 후 결과만 PR.md
 * 에 기록 (047 hot-fix 의 회귀 차단 자동화).
 */

const VIEWPORT_DESKTOP = { width: 1280, height: 720 };
const HEIGHT_THRESHOLD_RATIO = 0.95;

type Surface = {
  name: string;
  url: string;
  description: string;
};

const SURFACES: Surface[] = [
  { name: 'shell-empty', url: '/', description: 'root → ProtectedShellRoute → /login redirect' },
  {
    name: 'channel',
    url: '/w/qufox-team/general',
    description: 'workspace channel → ProtectedShellRoute → /login redirect',
  },
  { name: 'dm-list', url: '/dm', description: 'DM list → ProtectedDmShellRoute → /login redirect' },
  {
    name: 'dm-thread',
    url: '/dm/00000000-0000-0000-0000-000000000000',
    description: 'DM thread → ProtectedDmShellRoute → /login redirect',
  },
  {
    name: 'profile',
    url: '/me/profile',
    description: 'my profile → ProtectedMyProfileRoute → /login redirect',
  },
  {
    name: 'settings',
    url: '/settings/notifications',
    description: 'settings → ProtectedSettingsRoute → /login redirect',
  },
  {
    name: 'discover',
    url: '/discover',
    description: 'discover → ProtectedDiscoverRoute → /login redirect',
  },
];

test.setTimeout(60_000);

test.describe('task-048 chunk B — AppLayout root height regression', () => {
  for (const surface of SURFACES) {
    test(`${surface.name} (${surface.description})`, async ({ page }) => {
      await page.setViewportSize(VIEWPORT_DESKTOP);
      // `domcontentloaded` 까지만 기다린다 — local-dist preview 는
      // backend (api/socket) 가 없어 `networkidle` 가 영구 timeout
      // 가능. `load` + 짧은 settle 로 lazy-import 의 첫 렌더 잡고
      // boundingBox 측정.
      await page.goto(surface.url, { waitUntil: 'load' });
      await page.evaluate(() => (document as Document & { fonts?: FontFaceSet }).fonts?.ready);
      await page.waitForTimeout(500);

      // 측정 대상: 페이지의 `<main>` 또는 의미 있는 content root 의
      // boundingBox.
      //
      // 왜 `#root > *` 가 아닌가? AppLayout (`<div style={{height:'100%',
      // ...}}>`) 자체는 `height:100%` 로 viewport 를 항상 채우기 때문에
      // 그 안의 wrapper `<div>` (047 iter7 회귀 패턴) 가 height 를
      // 잘라먹어도 `#root > *` 는 720px 으로 측정된다. 회귀는
      // **AppLayout > flex:1 wrapper > ErrorBoundary > children** 체인
      // 안쪽에서 발생 — children 인 LoginPage 의 `<main className="flex
      // min-h-full ...">` 의 `min-h-full` 이 끊긴 부모 height (auto)
      // 를 100% 채워서 사실상 0 px 으로 collapse.
      //
      // 따라서 LoginPage 의 `<main>` 또는 다른 page 의 content root 의
      // boundingBox 가 viewport 의 95% 이상이어야 정상.
      const main = page.locator('main, [data-testid="app-error-boundary"]').first();
      await main.waitFor({ state: 'attached', timeout: 10_000 });
      const box = await main.boundingBox();
      expect(
        box,
        `main container의 boundingBox 가 null 이면 안 됨 (${surface.url})`,
      ).not.toBeNull();
      const minHeight = VIEWPORT_DESKTOP.height * HEIGHT_THRESHOLD_RATIO;
      expect(
        box!.height,
        `${surface.url}: main height ${box!.height}px < ${minHeight}px (${HEIGHT_THRESHOLD_RATIO * 100}% of viewport ${VIEWPORT_DESKTOP.height}px). ` +
          `이 fail 은 AppLayout flex/height 흐름이 끊긴 회귀 (예: ErrorBoundary 가 wrapper <div> 로 children 을 감쌌을 때 047 iter7 패턴) 의 시그널입니다.`,
      ).toBeGreaterThanOrEqual(minHeight);
    });
  }
});
