import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

test('desktop /activity shows mention row + click opens source + marks read', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `act-${stamp.toString(36)}`;
  const bossEmail = `act-boss-${stamp}@qufox.dev`;
  const meEmail = `act-me-${stamp}@qufox.dev`;
  const meUser = `actme${stamp}`;

  const boss = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: bossEmail, username: `actboss${stamp}`, password: PW },
  });
  const bossToken = ((await boss.json()) as { accessToken: string }).accessToken;
  const me = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: meEmail, username: meUser, password: PW },
  });
  const meBody = (await me.json()) as { accessToken: string; user: { id: string } };

  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${bossToken}`, origin: ORIGIN },
    data: { name: 'Activity', slug },
  });
  const wsId = ((await ws.json()) as { id: string }).id;
  // invite me via direct API call (simpler than the invite flow)
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
  // Boss mentions me.
  await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
    headers: { authorization: `Bearer ${bossToken}`, origin: ORIGIN },
    data: {
      idempotencyKey: `mention-${stamp}`,
      content: `hey <@${meBody.user.id}> can you review?`,
      mentions: { users: [meBody.user.id], channels: [], everyone: false },
    },
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(meEmail);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/w\//);

  await page.goto('/activity');
  await expect(page.getByTestId('activity-page')).toBeVisible();
  const row = page.locator('[data-testid^="activity-row-mention:"]').first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-kind', 'mention');
  await expect(row).toHaveAttribute('data-read', 'false');

  // Click row → should navigate and mark read.
  await row.click();
  await page.waitForURL(new RegExp(`/w/${slug}`));

  // Return to /activity — row should now be read.
  await page.goto('/activity');
  const rowAfter = page.locator('[data-testid^="activity-row-mention:"]').first();
  await expect(rowAfter).toHaveAttribute('data-read', 'true');

  await context.close();
});
