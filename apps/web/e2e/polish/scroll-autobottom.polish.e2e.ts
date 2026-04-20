import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-021 polish harness — scroll autobottom behavior.
 *
 * At-bottom → new messages visible, scroll stays at bottom.
 * Scrolled-up → new arrival does NOT yank scroll (MessageList's
 * nearBottom guard must hold).
 *
 * Harness posts a small burst of messages from the API side so the
 * E2E avoids the composer path.
 */
test.setTimeout(120_000);
test('polish: scroll does not jump when the viewer is scrolled up (R1 detector)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `pols-${stamp.toString(36)}`;
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `pols-o-${stamp}@qufox.dev`, username: `polso${stamp}`, password: PW },
  });
  const ownerToken = (await owner.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'PolishScroll', slug },
  });
  const wsId = (await ws.json()).id as string;
  const ch = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const chId = (await ch.json()).id as string;
  for (let i = 0; i < 50; i += 1) {
    await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
      headers: {
        authorization: `Bearer ${ownerToken}`,
        origin: ORIGIN,
        'idempotency-key': crypto.randomUUID(),
      },
      data: { content: `seed-${i}` },
    });
  }

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/login');
  await pageB.getByTestId('login-email').fill(`pols-o-${stamp}@qufox.dev`);
  await pageB.getByTestId('login-password').fill(PW);
  await pageB.getByTestId('login-submit').click();
  await expect(pageB).toHaveURL(new RegExp(`/w/${slug}`));
  await pageB.getByTestId('channel-general').click();

  const scrollable = pageB.getByTestId('msg-list');
  await expect(scrollable).toBeVisible();
  // Scroll up substantially.
  await scrollable.evaluate((el) => {
    el.scrollTop = 0;
  });
  const topBefore = await scrollable.evaluate((el) => el.scrollTop);

  // Post 3 more via API.
  for (let i = 0; i < 3; i += 1) {
    await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
      headers: {
        authorization: `Bearer ${ownerToken}`,
        origin: ORIGIN,
        'idempotency-key': crypto.randomUUID(),
      },
      data: { content: `late-${i}` },
    });
  }
  await pageB.waitForTimeout(1500);

  const topAfter = await scrollable.evaluate((el) => el.scrollTop);
  // Allow small drift for layout shifts but NOT a yank to bottom.
  expect(Math.abs(topAfter - topBefore)).toBeLessThan(80);
});
