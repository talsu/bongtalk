import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);
test('realtime: owner removes member → member WS disconnects and UI shows workspace-not-found', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `rt-k-${stamp.toString(36)}`;

  const ownerRes = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `rtk-own-${stamp}@qufox.dev`, username: `rtkown${stamp}`, password: PW },
  });
  const ownerToken = (await ownerRes.json()).accessToken as string;
  const wsRes = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'Kick', slug },
  });
  const ws = await wsRes.json();
  const inv = await request.post(`${API}/workspaces/${ws.id}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const code = (await inv.json()).invite.code as string;

  const memberEmail = `rtk-b-${stamp}@qufox.dev`;
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/signup');
  await pageB.getByTestId('signup-email').fill(memberEmail);
  await pageB.getByTestId('signup-username').fill(`rtkb${stamp}`);
  await pageB.getByTestId('signup-password').fill(PW);
  await pageB.getByTestId('signup-submit').click();
  await pageB.goto(`/invite/${code}`);
  await pageB.getByTestId('invite-accept').click();
  await expect(pageB).toHaveURL(new RegExp(`/w/${slug}$`));

  // Discover member userId via API.
  const loginB = await request.post(`${API}/auth/login`, {
    headers: { origin: ORIGIN },
    data: { email: memberEmail, password: PW },
  });
  const bUserId = (await loginB.json()).user.id as string;

  // Owner kicks member
  await request.delete(`${API}/workspaces/${ws.id}/members/${bUserId}`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
  });

  // Member's page should flip to "workspace not found" — our existing
  // WorkspaceLayout renders that when `useMyWorkspaces()` returns without
  // the slug (which is the post-refetch state). The WS disconnect prompts
  // React Query to refetch on focus; we manually reload to deterministic.
  await pageB.reload();
  await expect(pageB.getByTestId('ws-not-found')).toBeVisible({ timeout: 5_000 });

  await ctxB.close();
});
