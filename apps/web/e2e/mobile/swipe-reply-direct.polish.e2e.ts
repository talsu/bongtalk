import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * task-025 polish harness. Regression guard for 024-follow-2 (MED):
 * swipe-right on a qf-m-message must enter reply-mode directly
 * (reply banner visible, sheet NOT rendered). Simulated via touch
 * event sequence so it exercises the real onTouchStart/Move/End
 * logic in MobileMessageRow.
 */
test.setTimeout(60_000);

test('swipe-right enters reply-mode, bypasses the long-press sheet', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mb-swrep-${stamp}@qufox.dev`;
  const username = `mbswrep${stamp}`;
  const slug = `mb-swrep-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'Swipe Reply',
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

  await page.getByTestId('mobile-msg-input').fill('swipe me');
  await page.getByTestId('mobile-composer-send').click();
  await expect(page.getByTestId('mobile-message-list')).toContainText('swipe me');

  const row = page
    .getByTestId('mobile-message-list')
    .locator('[data-testid^="mobile-msg-"][data-mine="true"]')
    .first();
  await expect(row).toBeVisible();

  // Touch sequence: start in the middle, drag 100px right, release.
  await row.evaluate((el) => {
    const target = el as HTMLElement;
    const rect = target.getBoundingClientRect();
    const startX = rect.left + rect.width * 0.3;
    const y = rect.top + rect.height / 2;
    const mkTouch = (clientX: number): Touch =>
      new Touch({ identifier: 1, target, clientX, clientY: y });

    target.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [mkTouch(startX)],
        targetTouches: [mkTouch(startX)],
        changedTouches: [mkTouch(startX)],
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      new TouchEvent('touchmove', {
        touches: [mkTouch(startX + 100)],
        targetTouches: [mkTouch(startX + 100)],
        changedTouches: [mkTouch(startX + 100)],
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      new TouchEvent('touchend', {
        touches: [],
        targetTouches: [],
        changedTouches: [mkTouch(startX + 100)],
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  // Reply banner appears; long-press sheet does NOT.
  await expect(page.getByTestId('mobile-reply-banner')).toBeVisible();
  await expect(page.locator('[data-testid^="mobile-msg-sheet-"]')).toHaveCount(0);

  // Cancelling the reply clears the banner.
  await page.getByTestId('mobile-reply-cancel').click();
  await expect(page.getByTestId('mobile-reply-banner')).toHaveCount(0);

  await context.close();
});
