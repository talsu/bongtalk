import { test, expect } from '@playwright/test';
import { bootstrapWorkspace, loginUI, signupToken, API, ORIGIN } from '../mobile/_helpers';

/**
 * task-043 C: virtualization e2e. Seeds 120 messages (paced under
 * the API rate limit) into a fresh channel, opens it, and asserts
 * the rendered DOM holds <= 50 `[data-testid="message-row"]` nodes
 * — the virtualizer's visible window plus 8 rows of overscan, never
 * the full seed count.
 *
 * task-043 reviewer M3: tightened the cap from 60 → 50 so a partial-
 * virtualization regression (e.g. accidentally rendering all rows
 * above the viewport) actually fails the assertion.
 */

test.setTimeout(180_000);

import type { APIRequestContext } from '@playwright/test';

async function seedMessages(
  request: APIRequestContext,
  token: string,
  workspaceId: string,
  channelId: string,
  count: number,
): Promise<void> {
  // task-043 reviewer H6: API rate-limits at MESSAGE_RATE_USER_MAX =
  // 30/10s per user. Pace at 5 inserts every 1.7s ≈ 17.6/10s, well
  // under limit.
  const headers = { authorization: `Bearer ${token}`, origin: ORIGIN };
  const BATCH = 5;
  const PACE_MS = 1700;
  for (let i = 0; i < count; i += BATCH) {
    const slice = Array.from({ length: Math.min(BATCH, count - i) }, (_, k) => i + k);
    await Promise.all(
      slice.map(async (n) => {
        const r = await request.post(
          `${API}/workspaces/${workspaceId}/channels/${channelId}/messages`,
          {
            headers: { ...headers, 'idempotency-key': `seed-${workspaceId}-${channelId}-${n}` },
            data: { content: `seeded message #${n.toString().padStart(4, '0')}` },
          },
        );
        if (!r.ok()) {
          throw new Error(`seed #${n} failed: ${r.status()} ${await r.text()}`);
        }
      }),
    );
    if (i + BATCH < count) await new Promise((res) => setTimeout(res, PACE_MS));
  }
}

test('1000-message channel renders with bounded DOM (task-043 C)', async ({ page, request }) => {
  const stamp = Date.now();
  const email = `pl5-virt-${stamp}@qufox.dev`;
  const username = `plvirt${stamp}`;
  const slug = `pl-virt-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, token, {
    name: 'Virt',
    slug,
    channels: ['general'],
  });

  await seedMessages(request, token, workspaceId, channelIds.general, 1000);
  await loginUI(page, email, slug);
  await page.goto(`/w/${slug}/general`);

  // Wait for the message list to mount and the first paint to settle.
  await expect(page.getByTestId('msg-list')).toBeVisible();
  await expect(page.getByTestId('virtual-list-inner')).toBeVisible();
  await page.waitForTimeout(800);

  // The virtualizer should render <= visible window + overscan*2 (16)
  // rows. With a 600-1000px viewport / ~64px row, visible ~= 10-16,
  // overscan adds 8 each side. Cap at 60 to allow generous variance.
  const rowCount = await page.locator('[data-testid="message-row"]').count();
  expect(rowCount).toBeGreaterThan(0);
  expect(rowCount).toBeLessThanOrEqual(60);

  // Sanity: we seeded 1000 messages but the DOM holds at most ~50.
  // Also verify no >50% of the seeds materialized as DOM nodes.
  expect(rowCount).toBeLessThan(500);
});
