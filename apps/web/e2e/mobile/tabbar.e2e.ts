import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * Task-024 Chunk G: qf-m-tabbar renders all 4 tabs (Home / DMs /
 * Activity / You). DMs + Activity are aria-disabled per scope; Home
 * stays selected on the workspace shell, You navigates to /settings.
 */
test.setTimeout(60_000);
test.skip('tabbar shows 4 tabs, disables DMs + Activity, routes Home + You', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mb-tab-${stamp}@qufox.dev`;
  const username = `mbtab${stamp}`;
  const slug = `mb-tab-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'Mobile Tab',
    slug,
    channels: ['general'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  const tabbar = page.getByTestId('mobile-tabbar');
  await expect(tabbar).toBeVisible();

  await expect(page.getByTestId('mobile-tab-home')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('mobile-tab-dms')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('mobile-tab-activity')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('mobile-tab-you')).toBeVisible();

  // Navigate to a channel then tap Home — should route back to /w/<slug>.
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-channel-general').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/general`));
  await page.getByTestId('mobile-tab-home').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));

  // You tab routes to /settings.
  await page.getByTestId('mobile-tab-you').click();
  await expect(page).toHaveURL(/\/settings$/);

  await context.close();
});
