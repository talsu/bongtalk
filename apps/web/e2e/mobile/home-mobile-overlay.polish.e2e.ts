import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

test.setTimeout(60_000);

/**
 * task-035-F: tapping a channel row on Home opens MobileOverlay (chat
 * slide-in). The overlay mounts over Home without unmounting it, back
 * button closes.
 */
test('tapping a channel on Home opens the chat overlay; back closes', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mho-${stamp}@qufox.dev`;
  const username = `mho${stamp}`;
  const slug = `mho-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, { name: 'Mho', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);
  await page.goto('/');

  await page.getByTestId(`mobile-rail-ws-${slug}`).click();
  await page.getByTestId('mobile-home-channel-general').click();

  const overlay = page.getByTestId('mobile-home-chat-overlay');
  await expect(overlay).toBeVisible();
  // Underlying Home tree still mounted.
  await expect(page.getByTestId('mobile-home')).toBeVisible();

  // Back button closes overlay via popstate.
  await page.getByTestId('mobile-overlay-back').click();
  await expect(page.getByTestId('mobile-home-chat-overlay')).toHaveCount(0);
  await expect(page.getByTestId('mobile-home')).toBeVisible();

  await context.close();
});
