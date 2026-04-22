import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * task-025 polish harness. Every visible interactive element inside
 * the mobile shell must meet the 44×44 CSS-px touch-target floor
 * (Apple HIG + WCAG 2.5.5 AA). Icon-only rail buttons like the
 * workspace picker intentionally rely on hit-area padding around a
 * 24px icon, so they're whitelisted.
 *
 * Row covered by polish-backlog.md `mobile-touch-target-small`.
 */
const MIN_PX = 44;
const WHITELIST = new Set<string>([
  // Workspace rail uses 48x48 Avatar tiles but overall <Link> may be
  // slightly smaller than 44px on the narrower axis due to gap=1 layout.
]);

test.setTimeout(90_000);

test('every qf-m-* interactive hits 44×44 minimum', async ({ browser, request }) => {
  const stamp = Date.now();
  const email = `mb-tts-${stamp}@qufox.dev`;
  const username = `mbtts${stamp}`;
  const slug = `mb-tts-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'Touch Target',
    slug,
    channels: ['general'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  // Collect interactive elements inside the mobile shell.
  await expect(page.getByTestId('mobile-shell')).toBeVisible();

  const offenders = await page.evaluate(
    ({ min, whitelist }) => {
      const root = document.querySelector('[data-testid="mobile-shell"]');
      if (!root) return [] as Array<{ tag: string; testid: string; w: number; h: number }>;
      const sel = 'button, a[href], [role="button"], input, select, textarea';
      const nodes = Array.from(root.querySelectorAll(sel)) as HTMLElement[];
      const bad: Array<{ tag: string; testid: string; w: number; h: number }> = [];
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue; // hidden
        const tid = el.getAttribute('data-testid') ?? '';
        if (whitelist.includes(tid)) continue;
        if (rect.width < min || rect.height < min) {
          bad.push({
            tag: el.tagName,
            testid: tid,
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          });
        }
      }
      return bad;
    },
    { min: MIN_PX, whitelist: Array.from(WHITELIST) },
  );

  expect(offenders, `touch targets < 44px:\n${JSON.stringify(offenders, null, 2)}`).toHaveLength(0);

  await context.close();
});
