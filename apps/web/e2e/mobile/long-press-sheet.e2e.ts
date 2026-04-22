import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * Task-024 Chunk F: long-press (500ms) on a qf-m-message opens the
 * bottom sheet with quick reactions + copy + delete. We simulate the
 * touch sequence via dispatchEvent since Playwright Chromium does not
 * expose a native long-press gesture.
 */
test.setTimeout(60_000);
test('long-press on my own message opens the bottom sheet with delete', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mb-sheet-${stamp}@qufox.dev`;
  const username = `mbsht${stamp}`;
  const slug = `mb-sheet-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'Mobile Sheet',
    slug,
    channels: ['general'],
  });

  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    hasTouch: true,
  });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-channel-general').click();
  await page.getByTestId('mobile-msg-input').fill('press me');
  await page.getByTestId('mobile-composer-send').click();
  await expect(page.getByTestId('mobile-message-list')).toContainText('press me');

  const row = page
    .getByTestId('mobile-message-list')
    .locator('[data-testid^="mobile-msg-"][data-mine="true"]')
    .first();
  await expect(row).toBeVisible();

  // Simulate the touch long-press via synthetic events so the
  // setTimeout(500) in MobileMessageRow fires.
  await row.evaluate((el) => {
    const target = el as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const touch = new Touch({
      identifier: 1,
      target,
      clientX: x,
      clientY: y,
    });
    target.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  // Wait longer than LONG_PRESS_MS (500ms).
  await page.waitForTimeout(650);

  const sheet = page.locator('[data-testid^="mobile-msg-sheet-"]').first();
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('mobile-msg-copy')).toBeVisible();
  await expect(page.getByTestId('mobile-msg-delete')).toBeVisible();

  // ESC closes the sheet.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  await context.close();
});
