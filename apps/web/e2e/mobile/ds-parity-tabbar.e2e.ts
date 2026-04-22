import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * task-026-G: mobile tabbar must contain qf-m-tab__icon + qf-m-tab__label
 * for every tab (matching mobile-mockups.jsx TabBar internal structure).
 */
test.setTimeout(60_000);

test('qf-m-tabbar renders DS internal structure (qf-m-tab__icon + __label) per tab', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mtabds-${stamp}@qufox.dev`;
  const username = `mtabds${stamp}`;
  const slug = `mtabds-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'MTab',
    slug,
    channels: ['general'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  const tabbar = page.getByTestId('mobile-tabbar');
  await expect(tabbar).toBeVisible();

  for (const id of ['mobile-tab-home', 'mobile-tab-dms', 'mobile-tab-activity', 'mobile-tab-you']) {
    const tab = page.getByTestId(id);
    await expect(tab.locator('.qf-m-tab__icon')).toBeVisible();
    await expect(tab.locator('.qf-m-tab__label')).toBeVisible();
  }

  await context.close();
});
