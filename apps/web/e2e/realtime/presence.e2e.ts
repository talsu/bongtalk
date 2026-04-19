import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('realtime presence: online dot appears on sidebar as member connects', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `rt-p-${stamp.toString(36)}`;
  const ownerRes = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `rtp-own-${stamp}@qufox.dev`, username: `rtpown${stamp}`, password: PW },
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

  const memberUsername = `rtpmem${stamp}`;
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/signup');
  await pageB.getByTestId('signup-email').fill(`rtp-b-${stamp}@qufox.dev`);
  await pageB.getByTestId('signup-username').fill(memberUsername);
  await pageB.getByTestId('signup-password').fill(PW);
  await pageB.getByTestId('signup-submit').click();
  await pageB.goto(`/invite/${code}`);
  await pageB.getByTestId('invite-accept').click();
  await expect(pageB).toHaveURL(new RegExp(`/w/${slug}$`));

  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto('/login');
  await pageA.getByTestId('login-email').fill(`rtp-own-${stamp}@qufox.dev`);
  await pageA.getByTestId('login-password').fill(PW);
  await pageA.getByTestId('login-submit').click();
  await pageA.goto(`/w/${slug}`);

  // Expect the presence dot on the member row to be emerald within 3s after
  // both connect. Throttler window is 200ms in test env but Playwright doesn't
  // see that override — keep the timeout generous.
  const dot = pageA.getByTestId(`presence-${memberUsername}`);
  await expect(dot).toBeVisible();
  await expect(dot).toHaveClass(/emerald/, { timeout: 5_000 });

  await ctxA.close();
  await ctxB.close();
});
