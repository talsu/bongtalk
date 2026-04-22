import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * task-025 polish harness. Documents current drawer-back behaviour:
 * the left drawer is pure React state, so the hardware back button
 * on Android navigates back instead of dismissing the drawer. This
 * spec asserts the status quo — any future history.pushState wiring
 * must flip the assertion.
 *
 * Row covered by polish-backlog.md `mobile-drawer-no-back-dismiss`.
 */
test.setTimeout(60_000);

test('drawer dismisses via backdrop/ESC; back button navigates (current behaviour)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mb-back-${stamp}@qufox.dev`;
  const username = `mbback${stamp}`;
  const slug = `mb-back-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'Drawer Back',
    slug,
    channels: ['alpha', 'beta'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  // Prove ESC closes the drawer — confirms the primary dismiss path.
  await page.getByTestId('mobile-topbar-menu').click();
  await expect(page.getByTestId('mobile-left-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mobile-left-drawer-root')).toHaveCount(0);

  // Prove backdrop click closes the drawer.
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-left-drawer-backdrop').click({ position: { x: 20, y: 200 } });
  await expect(page.getByTestId('mobile-left-drawer-root')).toHaveCount(0);

  // Current known gap: hardware back navigates instead of closing.
  // This branch documents that so polish can flip it with pushState.
  await page.getByTestId('mobile-channel-alpha').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/alpha`));
  await page.getByTestId('mobile-topbar-menu').click();
  await expect(page.getByTestId('mobile-left-drawer')).toBeVisible();
  await page.goBack();
  // Until follow-up adds history.pushState, back navigation to prior
  // URL is the expected outcome and drawer root is removed too.
  await expect(page.getByTestId('mobile-left-drawer-root')).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(`/w/${slug}/alpha$`));

  await context.close();
});
