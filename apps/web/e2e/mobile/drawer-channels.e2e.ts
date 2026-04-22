import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * Task-024 Chunk C: left drawer opens, lists channels, dismisses on
 * pick, and routes to the chosen channel (also proves the swipe /
 * tap flow end to end).
 */
test.setTimeout(60_000);
test('left drawer lists channels; pick navigates and dismisses', async ({ browser, request }) => {
  const stamp = Date.now();
  const email = `mb-drawer-${stamp}@qufox.dev`;
  const username = `mbdrw${stamp}`;
  const slug = `mb-drawer-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'Mobile Drawer',
    slug,
    channels: ['alpha', 'beta'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  await expect(page.getByTestId('mobile-left-drawer-root')).toHaveCount(0);
  await page.getByTestId('mobile-topbar-menu').click();
  await expect(page.getByTestId('mobile-left-drawer')).toBeVisible();
  await expect(page.getByTestId('mobile-channel-alpha')).toBeVisible();
  await expect(page.getByTestId('mobile-channel-beta')).toBeVisible();

  await page.getByTestId('mobile-channel-alpha').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/alpha`));
  // Drawer must dismiss after pick.
  await expect(page.getByTestId('mobile-left-drawer-root')).toHaveCount(0);
  // Topbar reflects the selected channel.
  await expect(page.getByTestId('mobile-shell')).toContainText('# alpha');

  await context.close();
});
