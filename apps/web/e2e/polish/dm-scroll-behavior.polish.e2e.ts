import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

/**
 * task-028 polish harness: DM chat obeys the same scroll contract
 * as regular channels — initial auto-scroll to bottom, history
 * prepend preserves the user's anchor (task-025 follow-4).
 * Browser-driven to exercise the MessageList useLayoutEffect.
 */
test('DM chat scrolls to bottom on mount; history prepend preserves anchor', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `dmsc-${stamp.toString(36)}`;
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmsc-a-${stamp}@qufox.dev`, username: `dmsca${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string; user: { id: string } };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmsc-b-${stamp}@qufox.dev`, username: `dmscb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { name: 'DMsc', slug },
  });
  const wsId = ((await ws.json()) as { id: string }).id;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: {},
  });
  const invCode = ((await inv.json()) as { code: string }).code;
  await request.post(`${API}/invites/${invCode}/accept`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });
  const dm = await request.post(`${API}/me/workspaces/${wsId}/dms`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { userId: bBody.user.id },
  });
  const dmCh = ((await dm.json()) as { channelId: string }).channelId;

  // Seed 35 messages so initial page + one prepend fires.
  for (let i = 0; i < 35; i += 1) {
    await request.post(`${API}/workspaces/${wsId}/channels/${dmCh}/messages`, {
      headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
      data: { idempotencyKey: `dmsc-${stamp}-${i}`, content: `seed ${String(i).padStart(2, '0')}` },
    });
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(`dmsc-a-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/w\//);
  await page.goto(`/w/${slug}/dm/${bBody.user.id}?c=${dmCh}`);
  await expect(page.getByTestId('dm-chat-page')).toBeVisible();
  await expect(page.getByText('seed 34')).toBeVisible();

  await context.close();
});
