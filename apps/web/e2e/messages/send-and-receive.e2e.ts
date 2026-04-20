import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);
test('send + see message in the same browser; second browser needs reload (task-005 will remove that)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `ms-s-${stamp.toString(36)}`;

  // Owner setup
  const ownerRes = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `ms-own-${stamp}@qufox.dev`, username: `msown${stamp}`, password: PW },
  });
  const ownerToken = (await ownerRes.json()).accessToken as string;
  const wsRes = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'MsgWs', slug },
  });
  const ws = await wsRes.json();
  const inv = await request.post(`${API}/workspaces/${ws.id}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const code = (await inv.json()).invite.code as string;

  // Owner creates a channel via API so the UI test doesn't hinge on dnd.
  const chRes = await request.post(`${API}/workspaces/${ws.id}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: `g-${stamp.toString(36).slice(-5)}`, type: 'TEXT' },
  });
  const channelName: string = (await chRes.json()).name;

  // Member B signs up + accepts invite via UI
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto('/signup');
  await pageA.getByTestId('signup-email').fill(`ms-a-${stamp}@qufox.dev`);
  await pageA.getByTestId('signup-username').fill(`msa${stamp}`);
  await pageA.getByTestId('signup-password').fill(PW);
  await pageA.getByTestId('signup-submit').click();
  await pageA.goto(`/invite/${code}`);
  await pageA.getByTestId('invite-accept').click();
  await expect(pageA).toHaveURL(new RegExp(`/w/${slug}$`));
  await pageA.goto(`/w/${slug}/${channelName}`);

  // Browser A sends a message
  await pageA.getByTestId('msg-input').fill('hello from A');
  await pageA.getByTestId('msg-send').click();
  await expect(pageA.getByText('hello from A')).toBeVisible();

  // Browser B (different user) — without the realtime fan-out from task-005,
  // a plain load should see the message via the history GET.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/signup');
  await pageB.getByTestId('signup-email').fill(`ms-b-${stamp}@qufox.dev`);
  await pageB.getByTestId('signup-username').fill(`msb${stamp}`);
  await pageB.getByTestId('signup-password').fill(PW);
  await pageB.getByTestId('signup-submit').click();
  await pageB.goto(`/invite/${code}`);
  await pageB.getByTestId('invite-accept').click();
  await pageB.goto(`/w/${slug}/${channelName}`);
  await expect(pageB.getByText('hello from A')).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});
