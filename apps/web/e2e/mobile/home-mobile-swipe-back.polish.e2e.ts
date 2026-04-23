import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

test.setTimeout(60_000);

/**
 * task-035-F: swipe-from-left-edge closes the overlay. Simulated via
 * synthetic touch events (Playwright Chromium doesn't expose a true
 * gesture for edge-swipe). A drag of ~120px from a start-x < 20 fires
 * history.back → overlay unmounts.
 */
test('swipe-right from the left edge closes the chat overlay', async ({ browser, request }) => {
  const stamp = Date.now();
  const email = `mhs-${stamp}@qufox.dev`;
  const username = `mhs${stamp}`;
  const slug = `mhs-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, { name: 'Mhs', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, email, slug);
  await page.goto('/');
  await page.getByTestId(`mobile-rail-ws-${slug}`).click();
  await page.getByTestId('mobile-home-channel-general').click();
  await expect(page.getByTestId('mobile-home-chat-overlay')).toBeVisible();

  // Simulate an edge-swipe: touchstart at x=5, move to x=150, touchend.
  await page.getByTestId('mobile-home-chat-overlay').evaluate((el) => {
    const target = el as HTMLElement;
    const touch0 = new Touch({ identifier: 1, target, clientX: 5, clientY: 200 });
    const touch1 = new Touch({ identifier: 1, target, clientX: 150, clientY: 200 });
    target.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [touch0],
        targetTouches: [touch0],
        changedTouches: [touch0],
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      new TouchEvent('touchmove', {
        touches: [touch1],
        targetTouches: [touch1],
        changedTouches: [touch1],
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      new TouchEvent('touchend', {
        touches: [],
        targetTouches: [],
        changedTouches: [touch1],
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  // Popstate fires → overlay closes.
  await expect(page.getByTestId('mobile-home-chat-overlay')).toHaveCount(0, { timeout: 5000 });

  await context.close();
});
