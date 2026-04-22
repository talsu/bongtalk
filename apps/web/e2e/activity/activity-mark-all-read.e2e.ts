import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

test('mark-all-read button clears unread badge across all rows', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `actma-${stamp.toString(36)}`;
  const bossEmail = `actma-boss-${stamp}@qufox.dev`;
  const meEmail = `actma-me-${stamp}@qufox.dev`;
  const meUser = `actma${stamp}`;

  const boss = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: bossEmail, username: `actmaboss${stamp}`, password: PW },
  });
  const bossToken = ((await boss.json()) as { accessToken: string }).accessToken;
  const me = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: meEmail, username: meUser, password: PW },
  });
  const meBody = (await me.json()) as { accessToken: string; user: { id: string } };
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${bossToken}`, origin: ORIGIN },
    data: { name: 'ActMA', slug },
  });
  const wsId = ((await ws.json()) as { id: string }).id;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${bossToken}`, origin: ORIGIN },
    data: {},
  });
  const invCode = ((await inv.json()) as { code: string }).code;
  await request.post(`${API}/invites/${invCode}/accept`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
  });
  const ch = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${bossToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const chId = ((await ch.json()) as { id: string }).id;
  for (let i = 0; i < 3; i += 1) {
    await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
      headers: { authorization: `Bearer ${bossToken}`, origin: ORIGIN },
      data: {
        idempotencyKey: `mentma-${stamp}-${i}`,
        content: `ping <@${meBody.user.id}> ${i}`,
        mentions: { users: [meBody.user.id], channels: [], everyone: false },
      },
    });
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(meEmail);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/w\//);

  await page.goto('/activity');
  await expect(page.getByTestId('activity-unread-total')).toBeVisible();

  await page.getByTestId('activity-mark-all-read').click();
  // Badge gone + all rows have data-read="true".
  await expect(page.getByTestId('activity-unread-total')).toHaveCount(0, { timeout: 10_000 });
  const rows = page.locator('[data-testid^="activity-row-"]');
  const count = await rows.count();
  for (let i = 0; i < count; i += 1) {
    await expect(rows.nth(i)).toHaveAttribute('data-read', 'true');
  }

  await context.close();
});
