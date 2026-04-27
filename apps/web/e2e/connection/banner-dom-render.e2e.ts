import { test, expect } from '@playwright/test';

/**
 * task-041 B-1 (review H2 follow): exercise the live ConnectionBanner
 * DOM render path end-to-end. The 040 R3 spec only proved the
 * `computeConnectionBanner` pure function; the real component logic
 * (navigator.onLine listeners, registration/cleanup, `data-level`
 * attribute, single-mount across shells) had no e2e coverage.
 *
 * Three scenarios + a single-mount invariant:
 *   1. normal — no offline / no realtime trouble → banner absent
 *   2. disconnect — `window.dispatchEvent(new Event('offline'))` →
 *      banner mounts with `data-level="offline"` and a Korean message
 *   3. reconnect — `window.dispatchEvent(new Event('online'))` →
 *      banner unmounts (selector returns 0)
 *   4. single-mount — banner appears at most once even when multiple
 *      Shell variants would have mounted their own copy under 040
 *      pre-fix code.
 *
 * The shell-route bootstrap pulls in the App-level `AppRealtimeHost`
 * → `<ConnectionBanner>`, so visiting `/login` (no auth required) is
 * enough to drive the listener.
 */

test.setTimeout(60_000);

test('banner DOM render: normal/offline/online + single-mount (task-041 B-1)', async ({ page }) => {
  await page.goto('/login');

  // 1. normal — banner absent
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);

  // 2. disconnect simulation
  await page.evaluate(() => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));
  });
  const offlineBanner = page.getByTestId('connection-banner');
  await expect(offlineBanner).toHaveCount(1);
  await expect(offlineBanner).toHaveAttribute('data-level', 'offline');
  await expect(offlineBanner).toContainText('인터넷');

  // 4. single-mount invariant: even with the full app loaded the
  //    banner should never appear twice on the page.
  const count = await page.locator('[data-testid="connection-banner"]').count();
  expect(count).toBe(1);

  // 3. reconnect simulation → banner removed
  await page.evaluate(() => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
});
