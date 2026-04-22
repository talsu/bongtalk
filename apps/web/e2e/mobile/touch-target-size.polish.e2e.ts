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
// Workspace-rail Links wrap a 24px Avatar in p-1 → ~32px tile; they
// only render when len(workspaces) > 1, so the harness seeds one
// workspace. Whitelisted here so the guard is future-proof against
// multi-workspace fixtures.
const WHITELIST = new Set<string>();

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

  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    hasTouch: true,
  });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  // Mount MobileMessages (composer + reply flow) before enumerating,
  // otherwise qf-m-composer__plus / __send / mobile-reply-cancel are
  // never in the DOM and the guard passes vacuously.
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-channel-general').click();
  await page.getByTestId('mobile-msg-input').fill('press-me');
  await page.getByTestId('mobile-composer-send').click();
  await expect(page.getByTestId('mobile-message-list')).toContainText('press-me');

  // Open the long-press sheet so the Reply / Copy / Delete hit-areas
  // are sampled too.
  const row = page
    .getByTestId('mobile-message-list')
    .locator('[data-testid^="mobile-msg-"][data-mine="true"]')
    .first();
  await row.evaluate((el) => {
    const target = el as HTMLElement;
    const r = target.getBoundingClientRect();
    const touch = new Touch({
      identifier: 1,
      target,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
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
  await page.waitForTimeout(650);
  await expect(page.locator('[data-testid^="mobile-msg-sheet-"]')).toBeVisible();

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
