import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('OWNER promotes MEMBER → ADMIN via dropdown; MEMBER leaves workspace', async ({ page, request, context }) => {
  const stamp = Date.now();
  const slug = `rl-${stamp.toString(36)}`;

  // --- Owner signs up via UI + creates workspace ---
  const emailOwner = `rla-${stamp}@qufox.dev`;
  const usernameOwner = `rla${stamp}`;
  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(emailOwner);
  await page.getByTestId('signup-username').fill(usernameOwner);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(usernameOwner);

  await page.goto('/w/new');
  await page.getByTestId('ws-name').fill('RoleLeave');
  await page.getByTestId('ws-slug').fill(slug);
  await page.getByTestId('ws-create-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));

  // --- User B signs up via API, then accepts invite via API (no UI dance) ---
  const emailB = `rlb-${stamp}@qufox.dev`;
  const usernameB = `rlb${stamp}`;
  const signup = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: emailB, username: usernameB, password: PW },
  });
  expect(signup.status()).toBe(201);
  const { accessToken: bToken } = (await signup.json()) as { accessToken: string };

  // Owner creates an invite via API
  const ownerPageCookies = await context.cookies();
  const ownerRefresh = ownerPageCookies.find((c) => c.name === 'refresh_token');
  expect(ownerRefresh).toBeTruthy();
  // Pull owner's access token out of the page module — simpler path: use the API too.
  const ownerLogin = await request.post(`${API}/auth/login`, {
    headers: { origin: ORIGIN },
    data: { email: emailOwner, password: PW },
  });
  expect(ownerLogin.status()).toBe(200);
  const ownerToken = (await ownerLogin.json()).accessToken as string;

  // Resolve workspace id by listing owner's workspaces
  const listRes = await request.get(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
  });
  const ws = (await listRes.json()).workspaces.find((w: { slug: string }) => w.slug === slug);
  const wsId = ws.id as string;

  const inviteRes = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${ownerToken}` },
    data: { maxUses: 5 },
  });
  expect(inviteRes.status()).toBe(201);
  const code = (await inviteRes.json()).invite.code as string;

  const acceptRes = await request.post(`${API}/invites/${code}/accept`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${bToken}` },
  });
  expect(acceptRes.status()).toBe(201);
  const bUserId = (await request.get(`${API}/auth/me`, {
    headers: { authorization: `Bearer ${bToken}` },
  }).then((r) => r.json())).id as string;

  // --- Owner (in UI) promotes B → ADMIN via dropdown ---
  await page.reload();
  await expect(page.getByTestId(`member-${usernameB}`)).toBeVisible();
  await page.getByTestId(`role-select-${usernameB}`).selectOption('ADMIN');
  await expect(page.getByTestId(`role-${usernameB}`)).toHaveText('ADMIN');

  // --- B removes themselves via API (same effect as "leave" button) ---
  const leaveRes = await request.post(`${API}/workspaces/${wsId}/members/me/leave`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${bToken}` },
  });
  expect(leaveRes.status()).toBe(204);
  // Smoke-check: the member row disappears from the UI on reload.
  await page.reload();
  await expect(page.getByTestId(`member-${usernameB}`)).toHaveCount(0);
  // Suppress unused var warnings
  expect(bUserId).toBeDefined();
});
