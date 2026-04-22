import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT,
  MOBILE_VIEWPORT_PRO,
  bootstrapWorkspace,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * task-025 polish harness. Simulates the software keyboard by
 * bumping --m-kb-inset (what useKeyboardDodge writes on real devices
 * from visualViewport) and asserts qf-m-composer padding-bottom
 * consumes it so the input stays above the keyboard. Also verifies
 * the inset clears when the keyboard closes.
 *
 * Regression guard for task-024 follow-1 (HIGH).
 */
test.setTimeout(60_000);

for (const { name, viewport } of [
  { name: 'iphone-se', viewport: MOBILE_VIEWPORT },
  { name: 'pixel-7', viewport: MOBILE_VIEWPORT_PRO },
] as const) {
  test(`composer padding absorbs --m-kb-inset (${name})`, async ({ browser, request }) => {
    const stamp = Date.now();
    const email = `mb-kb-${name}-${stamp}@qufox.dev`;
    const username = `mbkb${name.replace(/-/g, '')}${stamp}`;
    const slug = `mb-kb-${name}-${stamp.toString(36)}`;

    const token = await signupToken(request, email, username);
    await bootstrapWorkspace(request, token, {
      name: `KB ${name}`,
      slug,
      channels: ['general'],
    });

    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await loginUI(page, email, slug);
    await page.getByTestId('mobile-topbar-menu').click();
    await page.getByTestId('mobile-channel-general').click();

    const composer = page.getByTestId('mobile-composer');
    await expect(composer).toBeVisible();

    const restingPadding = await composer.evaluate(
      (el) => parseFloat(getComputedStyle(el as HTMLElement).paddingBottom) || 0,
    );

    // Simulate keyboard opening: 280px inset (roughly iPhone SE kb).
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--m-kb-inset', '280px');
    });
    const lifted = await composer.evaluate(
      (el) => parseFloat(getComputedStyle(el as HTMLElement).paddingBottom) || 0,
    );
    expect(lifted).toBeGreaterThan(restingPadding + 250);

    // Close keyboard: inset returns to 0 → padding returns to resting.
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--m-kb-inset', '0px');
    });
    const dropped = await composer.evaluate(
      (el) => parseFloat(getComputedStyle(el as HTMLElement).paddingBottom) || 0,
    );
    expect(Math.abs(dropped - restingPadding)).toBeLessThan(2);

    await context.close();
  });
}
