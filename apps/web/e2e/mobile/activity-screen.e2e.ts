import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * task-026-I: mobile /activity screen must have the DS-parity
 * structure from the ScreenActivity mockup — qf-m-segment with 4
 * buttons, qf-m-fab mark-all-read, qf-m-topbar__titleBlock, and the
 * qf-m-tabbar shown at the bottom with Activity active.
 */
test.setTimeout(60_000);

test('/activity on mobile shows qf-m-segment + qf-m-fab + qf-m-tabbar activity selected', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mact-${stamp}@qufox.dev`;
  const username = `mact${stamp}`;
  const slug = `mact-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'MAct',
    slug,
    channels: ['general'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);
  await page.goto('/activity');

  await expect(page.getByTestId('mobile-activity')).toBeVisible();
  const segment = page.getByTestId('mobile-activity-segment');
  await expect(segment).toBeVisible();
  await expect(page.getByTestId('mobile-activity-tab-all')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByTestId('mobile-activity-tab-mentions').click();
  await expect(page.getByTestId('mobile-activity-tab-mentions')).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await expect(page.getByTestId('mobile-activity-fab-mark-all')).toBeVisible();
  await expect(page.getByTestId('mobile-tabbar')).toBeVisible();
  await expect(page.getByTestId('mobile-tab-activity')).toHaveAttribute('aria-selected', 'true');

  await context.close();
});
