import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('MEMBER does not see the channel create panel and cannot POST via API', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `ch-pm-${stamp.toString(36)}`;

  // Owner setup via API
  const ownerSignup = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: {
      email: `chpm-own-${stamp}@qufox.dev`,
      username: `chpmown${stamp}`,
      password: PW,
    },
  });
  const ownerToken = (await ownerSignup.json()).accessToken as string;
  const wsRes = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'PermsWs', slug },
  });
  const ws = await wsRes.json();
  const inv = await request.post(`${API}/workspaces/${ws.id}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const code = (await inv.json()).invite.code as string;

  // Member signs up via UI + accepts invite
  const memberEmail = `chpm-mem-${stamp}@qufox.dev`;
  const memberUsername = `chpmmem${stamp}`;
  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(memberEmail);
  await page.getByTestId('signup-username').fill(memberUsername);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(memberUsername);
  await page.goto(`/invite/${code}`);
  await page.getByTestId('invite-accept').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));

  // MEMBER sees no channel-create panel
  await expect(page.getByTestId('channel-create-panel')).toHaveCount(0);

  // And the API returns 403 INSUFFICIENT_ROLE when the member tries directly
  const memberLogin = await request.post(`${API}/auth/login`, {
    headers: { origin: ORIGIN },
    data: { email: memberEmail, password: PW },
  });
  const memberToken = (await memberLogin.json()).accessToken as string;
  const forbidden = await request.post(`${API}/workspaces/${ws.id}/channels`, {
    headers: { authorization: `Bearer ${memberToken}`, origin: ORIGIN },
    data: { name: `sneaky-${stamp.toString(36)}`, type: 'TEXT' },
  });
  expect(forbidden.status()).toBe(403);
  const body = await forbidden.json();
  expect(body.errorCode).toBe('WORKSPACE_INSUFFICIENT_ROLE');
});
