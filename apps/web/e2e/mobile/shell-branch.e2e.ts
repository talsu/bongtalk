import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * Task-024 Chunk A/B: useBreakpoint branches Shell.tsx. Viewport
 * < 768px must render qf-m-screen + qf-m-topbar + qf-m-tabbar; no
 * desktop shell-root in the DOM.
 */
test.setTimeout(60_000);
test('mobile viewport renders the mobile shell, not the desktop one', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mb-shell-${stamp}@qufox.dev`;
  const username = `mbshell${stamp}`;
  const slug = `mb-shell-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'Mobile Shell',
    slug,
    channels: ['general'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  await expect(page.getByTestId('mobile-shell')).toBeVisible();
  await expect(page.getByTestId('mobile-tabbar')).toBeVisible();
  await expect(page.getByTestId('mobile-topbar-menu')).toBeVisible();
  // Desktop shell must not be mounted.
  await expect(page.getByTestId('shell-root')).toHaveCount(0);

  await context.close();
});
