import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

test.setTimeout(60_000);

/**
 * task-033-G: mobile tabbar is 3 tabs now (Home / Activity / Settings).
 * DMs tab is gone — DMs live inside Home via the server-rail button.
 */
test('mobile tabbar exposes 3 tabs exactly: home, activity, settings', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `tb3-${stamp}@qufox.dev`;
  const username = `tb3${stamp}`;
  const slug = `tb3-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, { name: 'Tb3', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  await expect(page.getByTestId('mobile-tabbar')).toBeVisible();
  await expect(page.getByTestId('mobile-tab-home')).toBeVisible();
  await expect(page.getByTestId('mobile-tab-activity')).toBeVisible();
  await expect(page.getByTestId('mobile-tab-settings')).toBeVisible();
  // DMs tab is removed.
  await expect(page.getByTestId('mobile-tab-dms')).toHaveCount(0);
  // "You" tab is renamed to Settings.
  await expect(page.getByTestId('mobile-tab-you')).toHaveCount(0);

  // Count = 3.
  const tabs = page.locator('[data-testid^="mobile-tab-"]');
  await expect(tabs).toHaveCount(3);

  await context.close();
});
