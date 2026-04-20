import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);
test('server rail shows unread badge for other workspaces within 2s (task-018-E)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slugA = `ruA-${stamp.toString(36)}`;
  const slugB = `ruB-${stamp.toString(36)}`;

  const me = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `me-${stamp}@qufox.dev`, username: `me${stamp}`, password: PW },
  });
  const meToken = (await me.json()).accessToken as string;

  const wsA = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${meToken}`, origin: ORIGIN },
    data: { name: 'WS-A', slug: slugA },
  });
  const wsAId = (await wsA.json()).id as string;
  await request.post(`${API}/workspaces/${wsAId}/channels`, {
    headers: { authorization: `Bearer ${meToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });

  const wsB = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${meToken}`, origin: ORIGIN },
    data: { name: 'WS-B', slug: slugB },
  });
  const wsBId = (await wsB.json()).id as string;
  const chB = await request.post(`${API}/workspaces/${wsBId}/channels`, {
    headers: { authorization: `Bearer ${meToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const chBId = (await chB.json()).id as string;

  const poster = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `poster-${stamp}@qufox.dev`, username: `poster${stamp}`, password: PW },
  });
  const posterToken = (await poster.json()).accessToken as string;
  const invite = await request.post(`${API}/workspaces/${wsBId}/invites`, {
    headers: { authorization: `Bearer ${meToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const code = (await invite.json()).code as string;
  await request.post(`${API}/invites/${code}/accept`, {
    headers: { authorization: `Bearer ${posterToken}`, origin: ORIGIN },
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(`me-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slugA}`));
  await expect(page.getByTestId(`ws-nav-${slugB}`)).toBeVisible();
  await expect(page.getByTestId(`ws-unread-${slugB}`)).toHaveCount(0);

  await request.post(`${API}/workspaces/${wsBId}/channels/${chBId}/messages`, {
    headers: {
      authorization: `Bearer ${posterToken}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: {
      content: '안녕하세요 서버 rail unread 테스트',
    },
  });

  await expect(page.getByTestId(`ws-unread-${slugB}`)).toHaveText(/^\d+$/, { timeout: 5000 });
});
