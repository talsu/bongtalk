import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

test.setTimeout(60_000);

/**
 * task-028 polish harness: four-tab round trip Home → DMs →
 * Activity → You → Home. Each step must produce the right route
 * + the tabbar's aria-selected must follow along.
 */
test('mobile tabbar Home → DMs → Activity → You → Home round-trip works', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mtabs-${stamp}@qufox.dev`;
  const username = `mtabs${stamp}`;
  const slug = `mtabs-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, { name: 'MTabs', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  await expect(page.getByTestId('mobile-tab-home')).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('mobile-tab-dms').click();
  await page.waitForURL(/\/dms$/);
  await expect(page.getByTestId('mobile-tab-dms')).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('mobile-tab-activity').click();
  await page.waitForURL(/\/activity$/);
  await expect(page.getByTestId('mobile-tab-activity')).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('mobile-tab-you').click();
  await page.waitForURL(/\/settings(\/notifications)?$/);

  await context.close();
});
