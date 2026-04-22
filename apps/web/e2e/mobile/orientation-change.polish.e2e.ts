import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * task-025 polish harness. Portrait → landscape via setViewportSize
 * must preserve the composer draft and the message list (same
 * scrollable container). setViewportSize does not fire a native
 * orientationchange event in headless Chromium, which is fine — the
 * shell relies on qf-m-body flex layout, not an explicit handler.
 *
 * Row covered by polish-backlog.md `mobile-rotate-state-loss`.
 */
test.setTimeout(60_000);

test('portrait → landscape preserves composer draft + message list', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mb-rot-${stamp}@qufox.dev`;
  const username = `mbrot${stamp}`;
  const slug = `mb-rot-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'Rotate',
    slug,
    channels: ['general'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-channel-general').click();

  await page.getByTestId('mobile-msg-input').fill('draft survives rotation');
  // Rotate to landscape.
  await page.setViewportSize({ width: MOBILE_VIEWPORT.height, height: MOBILE_VIEWPORT.width });

  // Shell still mounted + composer draft preserved.
  await expect(page.getByTestId('mobile-shell')).toBeVisible();
  await expect(page.getByTestId('mobile-msg-input')).toHaveValue('draft survives rotation');

  // Rotate back to portrait.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByTestId('mobile-shell')).toBeVisible();
  await expect(page.getByTestId('mobile-msg-input')).toHaveValue('draft survives rotation');

  await context.close();
});
