import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

test.setTimeout(60_000);

test('mobile tabbar DMs tab is enabled and routes to /dms', async ({ browser, request }) => {
  const stamp = Date.now();
  const email = `mdmt-${stamp}@qufox.dev`;
  const username = `mdmt${stamp}`;
  const slug = `mdmt-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, { name: 'MDmT', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  const dmsTab = page.getByTestId('mobile-tab-dms');
  await expect(dmsTab).toBeVisible();
  // No longer disabled (was aria-disabled=true in 024+025+026).
  await expect(dmsTab).not.toHaveAttribute('aria-disabled', 'true');

  await dmsTab.click();
  await page.waitForURL(/\/dms$/);
  await expect(page.getByTestId('mobile-dm-list')).toBeVisible();
  await expect(page.getByTestId('mobile-dm-search')).toBeVisible();
  await expect(page.getByTestId('mobile-dm-fab-new')).toBeVisible();
  await expect(page.getByTestId('mobile-tab-dms')).toHaveAttribute('aria-selected', 'true');

  await context.close();
});
