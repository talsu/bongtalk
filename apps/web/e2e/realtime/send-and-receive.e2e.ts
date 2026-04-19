import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);
test('realtime: A sends, B sees within 2s (WS fan-out)', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `rt-sr-${stamp.toString(36)}`;
  const ownerRes = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `rt-own-${stamp}@qufox.dev`, username: `rtown${stamp}`, password: PW },
  });
  const ownerToken = (await ownerRes.json()).accessToken as string;
  const wsRes = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'RT', slug },
  });
  const ws = await wsRes.json();
  const inv = await request.post(`${API}/workspaces/${ws.id}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const code = (await inv.json()).invite.code as string;
  const chRes = await request.post(`${API}/workspaces/${ws.id}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: `rt-${stamp.toString(36).slice(-5)}`, type: 'TEXT' },
  });
  const channelName: string = (await chRes.json()).name;

  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto('/signup');
  await pageA.getByTestId('signup-email').fill(`rt-a-${stamp}@qufox.dev`);
  await pageA.getByTestId('signup-username').fill(`rta${stamp}`);
  await pageA.getByTestId('signup-password').fill(PW);
  await pageA.getByTestId('signup-submit').click();
  await pageA.goto(`/invite/${code}`);
  await pageA.getByTestId('invite-accept').click();

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/signup');
  await pageB.getByTestId('signup-email').fill(`rt-b-${stamp}@qufox.dev`);
  await pageB.getByTestId('signup-username').fill(`rtb${stamp}`);
  await pageB.getByTestId('signup-password').fill(PW);
  await pageB.getByTestId('signup-submit').click();
  await pageB.goto(`/invite/${code}`);
  await pageB.getByTestId('invite-accept').click();

  // Both navigate into the channel; B keeps it open, A posts.
  await Promise.all([
    pageA.goto(`/w/${slug}/${channelName}`),
    pageB.goto(`/w/${slug}/${channelName}`),
  ]);

  await pageA.getByTestId('msg-input').fill('live hi');
  await pageA.getByTestId('msg-send').click();

  // Without realtime the message would only appear on reload. Assert B sees
  // it within 2s — this is the task-005 contract.
  await expect(pageB.getByText('live hi')).toBeVisible({ timeout: 3_000 });

  await ctxA.close();
  await ctxB.close();
});
