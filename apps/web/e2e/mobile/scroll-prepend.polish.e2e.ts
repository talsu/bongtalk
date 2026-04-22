import { test, expect } from '@playwright/test';
import { API, MOBILE_VIEWPORT, ORIGIN, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * task-025 polish harness. Regression guard for 024-follow-4 (MED):
 * when useMessageHistory prepends an older page, the auto-scroll
 * effect used to snap to the bottom, yanking the user off the
 * history they asked for. Fix: the effect gates on
 * !isFetchingNextPage and, during a prepend, shifts scrollTop by
 * the height delta to preserve the anchor.
 *
 * Also positive-path: at bottom + new message → auto-snap still works.
 */
test.setTimeout(120_000);

test('history prepend preserves scroll anchor; new-msg still auto-snaps', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mb-scrprep-${stamp}@qufox.dev`;
  const username = `mbprep${stamp}`;
  const slug = `mb-scrprep-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, token, {
    name: 'Scroll Prepend',
    slug,
    channels: ['general'],
  });

  // Seed 40 messages via API so the initial page (20-ish) + one prepend
  // fetches at least one more page.
  for (let i = 0; i < 40; i += 1) {
    await request.post(`${API}/workspaces/${workspaceId}/channels/${channelIds.general}/messages`, {
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      data: {
        idempotencyKey: `seed-${stamp}-${i}`,
        content: `seed-msg-${String(i).padStart(3, '0')}`,
      },
    });
  }

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-channel-general').click();

  const list = page.getByTestId('mobile-message-list');
  await expect(list).toBeVisible();
  await expect(list).toContainText('seed-msg-039');

  // Scroll to the top to trigger prepend.
  const beforeTop = await list.evaluate((el) => {
    (el as HTMLElement).scrollTop = 0;
    return (el as HTMLElement).scrollTop;
  });
  expect(beforeTop).toBe(0);

  // Wait for the prepended page to render — look for a smaller-indexed
  // seed that could only be in an older page.
  await expect(list).toContainText('seed-msg-000', { timeout: 15_000 });

  // Anchor preserved: scrollTop should NOT be at the bottom. The fix
  // shifts scrollTop by the delta so we stay near the just-loaded top.
  const afterTop = await list.evaluate((el) => (el as HTMLElement).scrollTop);
  const scrollHeight = await list.evaluate((el) => (el as HTMLElement).scrollHeight);
  const clientHeight = await list.evaluate((el) => (el as HTMLElement).clientHeight);
  const distanceFromBottom = scrollHeight - afterTop - clientHeight;
  expect(distanceFromBottom).toBeGreaterThan(200);

  // Positive path: jump to bottom, send a new message, should auto-snap.
  await list.evaluate((el) => {
    (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
  });
  await page.getByTestId('mobile-msg-input').fill('new message after prepend');
  await page.getByTestId('mobile-composer-send').click();
  await expect(list).toContainText('new message after prepend');
  const topAfterNew = await list.evaluate((el) => (el as HTMLElement).scrollTop);
  const heightAfterNew = await list.evaluate((el) => (el as HTMLElement).scrollHeight);
  const clientAfterNew = await list.evaluate((el) => (el as HTMLElement).clientHeight);
  expect(heightAfterNew - topAfterNew - clientAfterNew).toBeLessThan(80);

  await context.close();
});
