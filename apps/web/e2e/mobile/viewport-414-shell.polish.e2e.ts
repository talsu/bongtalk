import { expect, test } from '@playwright/test';
import { MOBILE_VIEWPORT_XR, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * task-040 R5: smoke the critical mobile flows on the 414x896 (iPhone
 * XR / 11) viewport to catch layout regressions only visible at the
 * wider mobile band. Existing polish specs run at 375; this one
 * verifies the same DOM doesn't blow out gutters / overflow on 414.
 */

test.use({ viewport: MOBILE_VIEWPORT_XR });

test.describe('mobile viewport 414x896 (task-040 R5)', () => {
  test('channel home renders without horizontal overflow', async ({ page, request }) => {
    const stamp = Date.now();
    const email = `pl4-r5-${stamp}@qufox.dev`;
    const token = await signupToken(request, email, `pl4r5${stamp}`);
    const slug = `pl4r5-${stamp.toString(36)}`;
    await bootstrapWorkspace(request, token, {
      name: 'PL4 R5',
      slug,
      channels: ['general'],
    });
    await loginUI(page, email, slug);
    await page.goto(`/w/${slug}/general`);

    // mobile shell mounted (768 breakpoint guard)
    await expect(page.getByTestId('mobile-msg-input')).toBeVisible();

    // no horizontal scroll on the home shell — the wider band must
    // stay within viewport. Tolerance is the body's natural scrollbar
    // width which is 0 on touch devices but mobile chromium emulation
    // adds none either.
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      vp: window.innerWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.vp);
  });

  test('DM tab opens new-DM sheet within viewport', async ({ page, request }) => {
    const stamp = Date.now();
    const slug = `pl4r5dm-${stamp.toString(36)}`;
    const token = await signupToken(request, `pl4-r5-dm-${stamp}@qufox.dev`, `pl4r5dm${stamp}`);
    await bootstrapWorkspace(request, token, {
      name: 'PL4 R5 DM',
      slug,
      channels: ['general'],
    });
    await loginUI(page, `pl4-r5-dm-${stamp}@qufox.dev`, slug);
    await page.goto('/dms');

    await expect(page.getByTestId('mobile-dm-search-input')).toBeVisible();
    const input = await page.getByTestId('mobile-dm-search-input').boundingBox();
    expect(input).not.toBeNull();
    if (input) {
      // Search input must stay inside the wider viewport — 414 - 16 gutters.
      expect(input.x).toBeGreaterThanOrEqual(0);
      expect(input.x + input.width).toBeLessThanOrEqual(MOBILE_VIEWPORT_XR.width);
    }
  });
});
