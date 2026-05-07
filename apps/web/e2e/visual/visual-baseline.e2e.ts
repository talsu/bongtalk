import { test, expect } from '@playwright/test';

/**
 * task-045 iteration 0: visual regression baseline.
 *
 * 044 의 H2 (baseline 미시드) 를 해소하기 위해 11 surface (데스크톱 7
 * + 모바일 4) 의 snapshot 을 확보합니다. baseline 이 존재해야
 * visual-regression-scanner 가 의미 있게 동작합니다.
 *
 * **시드 전략**: DS source-of-truth (`/design-system/index.html`) 의
 * `data-page` 섹션을 활용. 인증/seed data 가 필요 없어 안정적이고
 * 재현 가능합니다. 라이브 shell ↔ 모킹 정합은 task-018-G 의
 * `ds-mockup-parity.e2e.ts` 가 별도 검증합니다.
 *
 * surface ↔ DS 페이지 매핑:
 * - shell                  → mockup     (3-column 전체 layout)
 * - channel-empty          → app-modals (채널 modal 빈 상태)
 * - channel-with-messages  → mockup     (메시지 포함 mockup)
 * - DM list                → app-dms    (DM shell)
 * - DM thread              → app-threads
 * - settings               → settings
 * - discover               → app-workspace (Workspace · Discover)
 * - 모바일 4 surface       → mobile     (단일 페이지에 4 device frame)
 *
 * mockup 페이지가 shell + channel-with-messages 두 surface 를 동시에
 * 노출하므로 snapshot 1 회로 두 surface 를 covers 합니다.
 *
 * **threshold**: maxDiffPixelRatio 0.02 (2%) — 폰트 antialias / cursor
 * blink 의 1-2% drift 허용. 실제 regression (요소 누락 / 색 flip) 은
 * 그보다 훨씬 큰 diff 를 만듭니다.
 *
 * **갱신 정책**: 의도된 DS 변경 시 `--update-snapshots` 명시 commit.
 * 의도 불명 변경은 BLOCKER.
 */

const THRESHOLD = Number(process.env.VISUAL_BASELINE_THRESHOLD ?? 0.02);

test.setTimeout(60_000);

type Surface = {
  name: string;
  page: string;
  description: string;
};

const DESKTOP_SURFACES: Surface[] = [
  { name: 'shell', page: 'mockup', description: '3-column 전체 shell + channel-with-messages' },
  { name: 'channel-empty', page: 'app-modals', description: '채널 modal / 빈 상태' },
  { name: 'dm-list', page: 'app-dms', description: 'DM shell + 좌측 list' },
  { name: 'dm-thread', page: 'app-threads', description: 'Thread 패널' },
  { name: 'settings', page: 'settings', description: '설정 / 폼 / states' },
  { name: 'discover', page: 'app-workspace', description: 'Workspace · Discover' },
  { name: 'channel-settings', page: 'app-channel-settings', description: '채널 settings 패널' },
];

const MOBILE_SURFACES: Surface[] = [
  // 모바일 페이지는 4 device frame 을 한 페이지에 보여줍니다.
  // home / DM list / channel / settings 4 frame 모두 한 snapshot 에 포함.
  {
    name: 'mobile-overview',
    page: 'mobile',
    description: '모바일 4 frame (home/DM/channel/settings)',
  },
];

async function navigateAndCapture(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  surface: Surface,
  filename: string,
) {
  await page.addInitScript((p: string) => {
    try {
      localStorage.setItem('qf-ds-page', p);
      document.documentElement.setAttribute('data-theme', 'dark');
    } catch {
      /* no-op */
    }
  }, surface.page);
  await page.goto(`/design-system/index.html#${surface.page}`);
  // 폰트 로드 대기 — flash of fallback 방지.
  await page.evaluate(() => (document as Document & { fonts?: FontFaceSet }).fonts?.ready);
  // nav() 가 실행되기 위한 짧은 settle 대기 (50ms).
  await page.waitForTimeout(100);
  await expect(page).toHaveScreenshot(filename, {
    maxDiffPixelRatio: THRESHOLD,
    fullPage: true,
  });
}

test.describe('task-045 visual baseline (desktop)', () => {
  for (const surface of DESKTOP_SURFACES) {
    test(`desktop · ${surface.name} (${surface.description})`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await navigateAndCapture(page, surface, `desktop-${surface.name}.png`);
    });
  }
});

test.describe('task-045 visual baseline (mobile)', () => {
  for (const surface of MOBILE_SURFACES) {
    test(`mobile · ${surface.name} (${surface.description})`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await navigateAndCapture(page, surface, `mobile-${surface.name}.png`);
    });
  }
});

/**
 * task-046 iter2: 모바일 surface 8 추가 — composer / DM thread /
 * reaction picker / emoji picker / workspace switch / sidebar drawer /
 * onboarding / pinned panel.
 *
 * 단일 mobile DS 페이지의 13 qf-m-screen 섹션 중에서 topbar title 기준
 * 으로 8 surface 를 ordinal scope. 045 의 mobile-overview (4 frame
 * 통합) 와 함께 9 개 모바일 baseline 운용 (확장 매트릭스 I1~I8 row 의
 * visual regression coverage).
 *
 * **시드 전략**: 각 surface 가 viewport 안에 들어오도록 element 를
 * `scrollIntoViewIfNeeded` → `.screenshot()` 으로 element 단위 capture.
 * full-page screenshot 은 시드 제어가 어려워 element 스코프 사용.
 *
 * **threshold**: maxDiffPixelRatio 0.02 (2%).
 *
 * **갱신**: DS 의 qf-m-screen 순서 / topbar title 변경은 의도적 변경
 * 으로 간주, `--update-snapshots` 명시 commit 필요.
 */
const MOBILE_SECTIONS_046: Array<{ name: string; nth: number; description: string }> = [
  { name: 'discover', nth: 0, description: 'I1/I5 — discover/workspace switch (찾기)' },
  { name: 'workspace-create', nth: 1, description: 'I7 — onboarding (새 워크스페이스)' },
  { name: 'channel-composer', nth: 2, description: 'I1 — channel composer (#general)' },
  { name: 'members', nth: 3, description: 'I6 — members drawer (멤버 · 42)' },
  { name: 'thread', nth: 6, description: 'I2/I3/I4 — thread + reaction/emoji picker' },
  { name: 'dm-list', nth: 7, description: 'I2 — DM list (메시지)' },
  { name: 'dm-thread', nth: 8, description: 'I2 — DM thread (민서)' },
  { name: 'pinned-panel', nth: 4, description: 'I8 — pinned panel (drawer overlay)' },
];

test.describe('task-046 mobile surface baseline (8 추가)', () => {
  for (const surface of MOBILE_SECTIONS_046) {
    test(`mobile · ${surface.name} (${surface.description})`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 700 });
      await page.addInitScript(() => {
        try {
          localStorage.setItem('qf-ds-page', 'mobile');
          document.documentElement.setAttribute('data-theme', 'dark');
        } catch {
          /* no-op */
        }
      });
      await page.goto('/design-system/index.html#mobile');
      await page.evaluate(() => (document as Document & { fonts?: FontFaceSet }).fonts?.ready);
      await page.waitForTimeout(150);
      const handle = page.locator('.qf-m-screen').nth(surface.nth);
      await handle.scrollIntoViewIfNeeded();
      await page.waitForTimeout(50);
      await expect(handle).toHaveScreenshot(`mobile-046-${surface.name}.png`, {
        maxDiffPixelRatio: THRESHOLD,
      });
    });
  }
});
