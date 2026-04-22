import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT,
  MOBILE_VIEWPORT_PRO,
  bootstrapWorkspace,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * Task-024 Chunk I: VR parity. Renders the seeded mobile shell at
 * iPhone SE (375×667) and iPhone 14 (390×844) and snapshots a stable
 * sub-tree. Threshold matches ds-mockup-parity — we want real
 * regressions (missing tabbar, topbar layout flip) to blow this up,
 * not 1-2% antialiasing drift.
 */
const THRESHOLD = Number(process.env.DS_PARITY_THRESHOLD ?? 0.02);

test.setTimeout(90_000);

for (const { name, viewport } of [
  { name: 'iphone-se', viewport: MOBILE_VIEWPORT },
  { name: 'iphone-14', viewport: MOBILE_VIEWPORT_PRO },
] as const) {
  test(`mobile shell renders stably at ${name} (${viewport.width}×${viewport.height})`, async ({
    browser,
    request,
  }) => {
    const stamp = Date.now();
    const email = `mb-vr-${name}-${stamp}@qufox.dev`;
    const username = `mbvr${name.replace(/-/g, '')}${stamp}`;
    const slug = `mb-vr-${name}-${stamp.toString(36)}`;

    const token = await signupToken(request, email, username);
    await bootstrapWorkspace(request, token, {
      name: `VR ${name}`,
      slug,
      channels: ['general'],
    });

    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await loginUI(page, email, slug);

    // Land on a channel so the topbar shows channel title / members icon.
    await page.getByTestId('mobile-topbar-menu').click();
    await page.getByTestId('mobile-channel-general').click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/general`));
    await page.getByTestId('mobile-shell').waitFor({ state: 'visible' });

    const shot = await page.getByTestId('mobile-shell').screenshot();
    expect(shot.length).toBeGreaterThan(500);
    await expect(page.getByTestId('mobile-shell')).toHaveScreenshot(`mobile-shell-${name}.png`, {
      maxDiffPixelRatio: THRESHOLD,
      animations: 'disabled',
    });

    await context.close();
  });
}
