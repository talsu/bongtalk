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

// task-049: 모바일 overview 4 frame.
//
// **부채**: 기존 045 `mobile-overview` 는 `data-page="mobile"` 페이지를
// `fullPage: true` 로 캡처했는데, prod 진단 결과 **page scrollHeight 가
// 5204px ↔ 5222px 로 18px 진동** (폰트/리플로우 타이밍) → toHaveScreenshot
// 이 안정 dimension 을 못 얻어 "Timeout 5000ms exceeded" 로 항상 fail
// (threshold 무관, stability 실패). desktop surface 는 page 높이가
// 안정적이라 fullPage 로도 통과하지만 mobile 페이지만 진동.
//
// **정정**: mobile 페이지의 4 device frame (`.qf-m-screen`, 각 304×608
// 고정 box) 을 **element screenshot** 으로 캡처. element box 는 고정
// 높이라 page-height 진동의 영향을 받지 않아 결정적 (mobile-046 시드와
// 동일 전략). 045 의 단일 `mobile-mobile-overview` fullPage baseline 은
// 폐기하고 frame 별 4 baseline 으로 대체.
const MOBILE_OVERVIEW_FRAMES: Array<{ name: string; nth: number; description: string }> = [
  { name: 'dm', nth: 0, description: 'Direct messages' },
  { name: 'general', nth: 1, description: '# general' },
  { name: 'activity', nth: 2, description: 'Activity' },
  { name: 'voice', nth: 3, description: '🔊 voice-lounge' },
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
  for (const frame of MOBILE_OVERVIEW_FRAMES) {
    test(`mobile · overview-${frame.name} (${frame.description})`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 900 });
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
      const handle = page.locator('section[data-page="mobile"].active .qf-m-screen').nth(frame.nth);
      await handle.scrollIntoViewIfNeeded();
      // 회귀 내성 (task-049 reviewer #2): DS 페이지에 .qf-m-screen 이
      // 추가/재정렬되면 positional nth 가 조용히 밀려 픽셀 diff 를 *내용*
      // 회귀로 오인하게 된다. capture 전에 frame 의 topbar title 을
      // anchor 검증해 nth 이탈을 명확한 title mismatch 로 실패시킨다.
      await expect(handle.locator('.qf-m-topbar__title')).toContainText(frame.description);
      await page.waitForTimeout(50);
      await expect(handle).toHaveScreenshot(`mobile-overview-${frame.name}.png`, {
        maxDiffPixelRatio: THRESHOLD,
      });
    });
  }
});

/**
 * task-046 iter2 모바일 surface 8 추가 — **task-049 chunk B 에서 시드
 * 전략 정정**.
 *
 * **부채 (task-048 `docs/visual-regression-broken-baselines.md` B 항)**:
 * 046 iter 2 는 8 surface 를 `#mobile` 페이지에서 `.qf-m-screen .nth(0..8)`
 * 로 시드하려 했으나 모두 `element is not visible` 로 104회 retry 후
 * timeout → baseline 디스크 commit 누락 → 매트릭스 broken.
 *
 * **근본 원인 (task-049 UNDERSTAND, prod 진단으로 확정)**: 이 8 surface
 * 의 `.phone` 프레임은 `data-page="mobile"` 페이지가 아니라
 * `app-workspace` / `app-channel-settings` / `app-modals` / `app-threads`
 * / `app-dms` **각 페이지**에 흩어져 있다 (`#mobile` 페이지엔 Direct
 * messages / Activity / voice 4 frame 만 존재). `#mobile` 활성화 시 다른
 * 페이지 섹션은 `display:none` → 그 안의 `.qf-m-screen` 은 0×0 →
 * actionability "not visible" 실패. 즉 broken 의 정체는 **global `.nth()`
 * 인덱싱이 숨겨진(비활성) 페이지의 요소를 가리킨 것**.
 *
 * **정정**: 각 surface 를 **자신의 DS 페이지로 navigate** 후, 활성 섹션
 * 내부의 `.qf-m-screen` 을 within-page nth 로 잡는다. 활성 페이지에서는
 * 358×718 로 정상 렌더되어 element screenshot 이 동작 (prod 진단 확인).
 *
 * **시드 환경**: prod (`--project=prod`) 또는 dist preview. DS 4파일
 * (`public/design-system/*`) 은 unchanged — test-side 만으로 정정.
 *
 * **threshold**: maxDiffPixelRatio 0.02 (2%).
 *
 * **갱신**: DS 의 page 별 `.qf-m-screen` 순서 변경은 의도적 변경으로
 * 간주, `--update-snapshots` 명시 commit 필요.
 */
const MOBILE_SURFACES_046: Array<{
  name: string;
  dsPage: string;
  nth: number;
  description: string;
  // 회귀 내성 (task-049 reviewer #2): capture 전 anchor 검증할 topbar
  // title. nth 가 DS 삽입으로 밀리면 title mismatch 로 명확히 실패한다.
  // overlay 등 topbar title 이 없는 frame 은 null.
  title: string | null;
}> = [
  {
    name: 'discover',
    dsPage: 'app-workspace',
    nth: 0,
    description: 'I1/I5 — 찾기 (discover)',
    title: '찾기',
  },
  {
    name: 'workspace-create',
    dsPage: 'app-workspace',
    nth: 1,
    description: 'I7 — 새 워크스페이스 (onboarding)',
    title: '새 워크스페이스',
  },
  {
    name: 'channel-composer',
    dsPage: 'app-channel-settings',
    nth: 0,
    description: 'I1 — #general composer',
    title: '#general',
  },
  {
    name: 'members',
    dsPage: 'app-channel-settings',
    nth: 1,
    description: 'I6 — 멤버 · 42 drawer',
    title: '멤버',
  },
  {
    name: 'pinned-panel',
    dsPage: 'app-modals',
    nth: 0,
    description: 'I8 — pinned panel (drawer overlay)',
    title: null,
  },
  {
    name: 'thread',
    dsPage: 'app-threads',
    nth: 0,
    description: 'I2/I3/I4 — 스레드 + picker',
    title: '스레드',
  },
  {
    name: 'dm-list',
    dsPage: 'app-dms',
    nth: 0,
    description: 'I2 — DM list (메시지)',
    title: '메시지',
  },
  {
    name: 'dm-thread',
    dsPage: 'app-dms',
    nth: 1,
    description: 'I2 — DM thread (민서)',
    title: '민서',
  },
];

test.describe('task-046 mobile surface baseline (8 추가)', () => {
  for (const surface of MOBILE_SURFACES_046) {
    test(`mobile · ${surface.name} (${surface.description})`, async ({ page }) => {
      // 데스크톱 viewport — phone 프레임 (360×720) 이 해당 app-* 페이지
      // 에서 온전히 렌더되도록. element screenshot 은 viewport 보다 큰
      // 요소도 자체 compositing 으로 전체 캡처.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.addInitScript((p: string) => {
        try {
          localStorage.setItem('qf-ds-page', p);
          document.documentElement.setAttribute('data-theme', 'dark');
        } catch {
          /* no-op */
        }
      }, surface.dsPage);
      await page.goto(`/design-system/index.html#${surface.dsPage}`);
      await page.evaluate(() => (document as Document & { fonts?: FontFaceSet }).fonts?.ready);
      await page.waitForTimeout(150);
      const handle = page
        .locator(`section[data-page="${surface.dsPage}"].active .qf-m-screen`)
        .nth(surface.nth);
      await handle.scrollIntoViewIfNeeded();
      // 회귀 내성 (task-049 reviewer #2): topbar title 이 있는 frame 은
      // capture 전 anchor 검증 → DS 삽입/재정렬로 nth 가 밀리면 픽셀 diff
      // 가 아니라 명확한 title mismatch 로 실패. overlay (title null) 는 skip.
      if (surface.title) {
        await expect(handle.locator('.qf-m-topbar__title')).toContainText(surface.title);
      }
      await page.waitForTimeout(50);
      await expect(handle).toHaveScreenshot(`mobile-046-${surface.name}.png`, {
        maxDiffPixelRatio: THRESHOLD,
      });
    });
  }
});
