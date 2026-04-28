import { test, expect, devices } from '@playwright/test';

/**
 * task-042 R0 F7 (review M6 follow): verify the ConnectionBanner
 * respects iOS safe-area-inset-top on a notched device. We use
 * Playwright's `iPhone 13` device emulation and force the offline
 * state, then capture the banner's bounding box. The padding-top
 * computed style must include the safe-area inset (>= 0px on the
 * emulator since Playwright doesn't simulate notch insets directly,
 * but the env() fallback chain should still report a non-empty
 * value).
 *
 * The screenshot is the human-readable artefact; the assertions are
 * the machine gate: banner appears, has data-level=offline, padding
 * uses the safe-area inset env().
 */

test.use({ ...devices['iPhone 13'] });
test.setTimeout(60_000);

test('banner respects iOS safe-area-inset-top on iPhone 13 (task-042 R0 F7)', async ({ page }) => {
  await page.goto('/login');

  // Force offline so the banner mounts.
  await page.evaluate(() => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));
  });

  const banner = page.getByTestId('connection-banner');
  await expect(banner).toHaveCount(1);
  await expect(banner).toHaveAttribute('data-level', 'offline');

  // The banner uses padding-top: calc(var(--s-2) + env(safe-area-inset-
  // top, 0px)) ... — assert the rendered padding-top is at least the
  // base var(--s-2) (4px) value. Playwright iPhone emulator typically
  // reports 0 for env(safe-area-inset-top), so the floor is the s-2.
  const paddingTop = await banner.evaluate((el) => {
    return window.getComputedStyle(el).paddingTop;
  });
  const px = parseFloat(paddingTop);
  expect(px).toBeGreaterThanOrEqual(4);

  // task-042 reviewer M2: also verify the inline style string itself
  // includes the safe-area-inset-top env() chain — guards against a
  // regression that strips env() (computed style would still show 4px
  // and fool the floor assertion above).
  const inlinePadding = await banner.evaluate((el) => (el as HTMLElement).style.padding);
  expect(inlinePadding).toContain('safe-area-inset-top');

  // Save the screenshot to test-results/ for human review.
  await banner.screenshot({ path: 'test-results/banner-ios-safe-area.png' });
});
