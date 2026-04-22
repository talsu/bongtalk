import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * task-025 polish harness. MobileShell resets leftOpen/rightOpen on
 * location.pathname change (useEffect), so route changes — channel
 * picks, hardware back, tab taps — all dismiss the drawer as a side
 * effect. This spec covers ESC, backdrop click, channel-pick, and
 * back-button paths.
 *
 * Row covered by polish-backlog.md `mobile-drawer-no-back-dismiss`.
 */
test.setTimeout(60_000);

test('drawer closes via ESC, backdrop, channel pick, and back button', async ({
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

  // ESC closes the drawer.
  await page.getByTestId('mobile-topbar-menu').click();
  await expect(page.getByTestId('mobile-left-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mobile-left-drawer-root')).toHaveCount(0);

  // Backdrop click closes the drawer.
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-left-drawer-backdrop').click({ position: { x: 20, y: 200 } });
  await expect(page.getByTestId('mobile-left-drawer-root')).toHaveCount(0);

  // Channel pick (route change) dismisses the drawer.
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-channel-alpha').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/alpha`));
  await expect(page.getByTestId('mobile-left-drawer-root')).toHaveCount(0);

  // Re-open the drawer and press back: location.pathname flips, the
  // useEffect in MobileShell clears leftOpen, drawer disappears.
  await page.getByTestId('mobile-topbar-menu').click();
  await expect(page.getByTestId('mobile-left-drawer')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('mobile-left-drawer-root')).toHaveCount(0);

  await context.close();
});
