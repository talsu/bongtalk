import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('realtime: role promotion arrives via WS without reload', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `rt-r-${stamp.toString(36)}`;
  const ownerRes = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `rtr-own-${stamp}@qufox.dev`, username: `rtrown${stamp}`, password: PW },
  });
  const ownerToken = (await ownerRes.json()).accessToken as string;
  const wsRes = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'Role', slug },
  });
  const ws = await wsRes.json();
  const inv = await request.post(`${API}/workspaces/${ws.id}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const code = (await inv.json()).invite.code as string;

  const memberEmail = `rtr-b-${stamp}@qufox.dev`;
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/signup');
  await pageB.getByTestId('signup-email').fill(memberEmail);
  await pageB.getByTestId('signup-username').fill(`rtrb${stamp}`);
  await pageB.getByTestId('signup-password').fill(PW);
  await pageB.getByTestId('signup-submit').click();
  await pageB.goto(`/invite/${code}`);
  await pageB.getByTestId('invite-accept').click();
  await expect(pageB.getByTestId('ws-my-role')).toHaveText('MEMBER');

  // Promote via API
  const loginB = await request.post(`${API}/auth/login`, {
    headers: { origin: ORIGIN },
    data: { email: memberEmail, password: PW },
  });
  const bUserId = (await loginB.json()).user.id as string;
  await request.patch(`${API}/workspaces/${ws.id}/members/${bUserId}/role`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { role: 'ADMIN' },
  });

  // Role-change event arrives; React Query invalidates + refetches workspace.
  // Poll up to 6s for the UI label to flip. Without realtime this would
  // only update on reload.
  await expect(pageB.getByTestId('ws-my-role')).toHaveText('ADMIN', { timeout: 6_000 });

  await ctxB.close();
});
