import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

test('topbar bell reflects new mention via WS dispatcher within seconds', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `actrt-${stamp.toString(36)}`;
  const bossEmail = `actrt-boss-${stamp}@qufox.dev`;
  const meEmail = `actrt-me-${stamp}@qufox.dev`;

  const boss = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: bossEmail, username: `actrtboss${stamp}`, password: PW },
  });
  const bossToken = ((await boss.json()) as { accessToken: string }).accessToken;
  const me = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: meEmail, username: `actrt${stamp}`, password: PW },
  });
  const meBody = (await me.json()) as { accessToken: string; user: { id: string } };
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${bossToken}`, origin: ORIGIN },
    data: { name: 'ActRT', slug },
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

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(meEmail);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/w\//);

  // No badge yet.
  await expect(page.getByTestId('topbar-activity-badge')).toHaveCount(0);

  // Boss mentions me while I'm viewing the shell.
  await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
    headers: { authorization: `Bearer ${bossToken}`, origin: ORIGIN },
    data: {
      idempotencyKey: `mrt-${stamp}`,
      content: `urgent <@${meBody.user.id}>`,
      mentions: { users: [meBody.user.id], channels: [], everyone: false },
    },
  });

  // Wait for badge to appear via dispatcher invalidation.
  await expect(page.getByTestId('topbar-activity-badge')).toBeVisible({ timeout: 10_000 });

  await context.close();
});
