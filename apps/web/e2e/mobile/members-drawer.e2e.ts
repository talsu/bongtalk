import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * Task-024 Chunk E: right drawer opens when the members icon is
 * tapped from the topbar; the authed user appears as a qf-m-row
 * with a data-presence attribute.
 */
test.setTimeout(60_000);
test('right drawer shows the workspace member list', async ({ browser, request }) => {
  const stamp = Date.now();
  const email = `mb-mem-${stamp}@qufox.dev`;
  const username = `mbmem${stamp}`;
  const slug = `mb-mem-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'Mobile Members',
    slug,
    channels: ['general'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  // Need to pick a channel first — the right drawer button is gated
  // on having an active channel.
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-channel-general').click();

  await page.getByTestId('mobile-topbar-members').click();
  await expect(page.getByTestId('mobile-right-drawer')).toBeVisible();
  const row = page.getByTestId(`mobile-member-${username}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-presence', /online|dnd|offline/);

  // Backdrop click dismisses.
  await page.getByTestId('mobile-right-drawer-backdrop').click({ position: { x: 10, y: 200 } });
  await expect(page.getByTestId('mobile-right-drawer-root')).toHaveCount(0);

  await context.close();
});
