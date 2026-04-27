import { test, expect } from '@playwright/test';
import { bootstrapWorkspace, loginUI, signupToken, MOBILE_VIEWPORT } from '../mobile/_helpers';

/**
 * task-042 R0 F6 (review M5 follow): authenticated multi-shell flow
 * verifying ConnectionBanner stays single-mount across shell variant
 * boundaries. The 040 hoist (review H1) put the banner at App root;
 * the 041 banner-dom-render.e2e.ts only proved single-mount on a
 * single page. This test extends the invariant: signup, navigate
 * between Shell (workspace) → DiscoverShell (/discover) → DmShell
 * (/dm) → mobile shell (`/dms` at MOBILE_VIEWPORT), assert count===1
 * after every navigation.
 */

test.setTimeout(90_000);

test('banner is single-mount across desktop+mobile shell navigations (task-042 R0 F6)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `pl5-r0-banner-${stamp}@qufox.dev`;
  const username = `pl5r0bn${stamp}`;
  const slug = `pl5r0bn-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'PL5 R0 Banner',
    slug,
    channels: ['general'],
  });

  // Desktop session
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const dPage = await desktop.newPage();
  await loginUI(dPage, email, slug);
  // Visit each shell variant on desktop and assert single-mount.
  for (const path of [`/w/${slug}/general`, '/discover', '/dm']) {
    await dPage.goto(path);
    // Banner default is hidden — assert ≤ 1.
    expect(await dPage.locator('[data-testid="connection-banner"]').count()).toBeLessThanOrEqual(1);
    // Then drive offline → assert exactly 1.
    await dPage.evaluate(() => {
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });
    await expect(dPage.getByTestId('connection-banner')).toHaveCount(1);
    // Reset to online before next navigation.
    await dPage.evaluate(() => {
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    await expect(dPage.getByTestId('connection-banner')).toHaveCount(0);
  }
  await desktop.close();

  // Mobile session — same single-mount invariant on the mobile shell.
  const mobile = await browser.newContext({ viewport: MOBILE_VIEWPORT, hasTouch: true });
  const mPage = await mobile.newPage();
  await loginUI(mPage, email, slug);
  for (const path of [`/w/${slug}/general`, '/dms']) {
    await mPage.goto(path);
    await mPage.evaluate(() => {
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });
    await expect(mPage.getByTestId('connection-banner')).toHaveCount(1);
    await mPage.evaluate(() => {
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
  }
  await mobile.close();
});
