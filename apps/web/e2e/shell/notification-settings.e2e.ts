import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);
test('notification settings: flip MENTION to OFF silences toast, BOTH restores it (task-019-D)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `notif-${stamp.toString(36)}`;

  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `notif-ow-${stamp}@qufox.dev`, username: `notifow${stamp}`, password: PW },
  });
  const ownerToken = (await owner.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'Notif', slug },
  });
  const wsId = (await ws.json()).id as string;
  const ch = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const chId = (await ch.json()).id as string;

  const target = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: {
      email: `notif-tg-${stamp}@qufox.dev`,
      username: `notiftg${stamp}`,
      password: PW,
    },
  });
  const targetToken = (await target.json()).accessToken as string;
  const targetUsername = `notiftg${stamp}`;
  const invite = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const inviteBody = await invite.json();
  const code = inviteBody.invite?.code ?? inviteBody.code;
  await request.post(`${API}/invites/${code}/accept`, {
    headers: { authorization: `Bearer ${targetToken}`, origin: ORIGIN },
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(`notif-tg-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));

  // Open settings from the BottomBar dropdown.
  await page.goto('/settings/notifications');
  await expect(page.getByTestId('notification-settings-page')).toBeVisible();

  // Flip MENTION on this workspace to OFF.
  await page.getByTestId(`notif-tab-${wsId}`).click();
  await page.getByTestId(`notif-radio-${wsId}-MENTION-OFF`).click();

  // Send a mention from owner to target.
  await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
    headers: {
      authorization: `Bearer ${ownerToken}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: `hello @${targetUsername}` },
  });

  await page.waitForTimeout(2000);
  await expect(page.getByTestId('toast-mention')).toHaveCount(0);

  // Flip back to BOTH.
  await page.getByTestId(`notif-radio-${wsId}-MENTION-BOTH`).click();

  // Second mention → toast fires.
  await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
    headers: {
      authorization: `Bearer ${ownerToken}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: `round 2 @${targetUsername}` },
  });

  await expect(page.getByTestId('toast-mention')).toBeVisible({ timeout: 5000 });
});
