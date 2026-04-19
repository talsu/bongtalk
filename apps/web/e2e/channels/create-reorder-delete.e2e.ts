import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('OWNER creates two channels → deletes one via API and UI reflects removal', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `ch-crd-${stamp.toString(36)}`;
  const email = `chcrd-${stamp}@qufox.dev`;
  const username = `chcrd${stamp}`;

  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-username').fill(username);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(username);

  await page.goto('/w/new');
  await page.getByTestId('ws-name').fill('Ch CRUD');
  await page.getByTestId('ws-slug').fill(slug);
  await page.getByTestId('ws-create-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));

  // Create two channels through the sidebar
  const ch1 = `general-${stamp.toString(36)}`;
  const ch2 = `random-${stamp.toString(36)}`;
  await page.getByTestId('new-channel-name').fill(ch1);
  await page.getByTestId('new-channel-submit').click();
  await expect(page.getByTestId(`channel-${ch1}`)).toBeVisible();

  await page.getByTestId('new-channel-name').fill(ch2);
  await page.getByTestId('new-channel-submit').click();
  await expect(page.getByTestId(`channel-${ch2}`)).toBeVisible();

  // Delete ch1 via API (OWNER role only — delete button lives in settings dialog,
  // not built in this task; the API call exercises the same code path).
  // Need an owner token — grab it by logging in via API.
  const login = await request.post(`${API}/auth/login`, {
    headers: { origin: ORIGIN },
    data: { email, password: PW },
  });
  const owner = await login.json();
  const listRes = await request.get(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });
  const ws = (await listRes.json()).workspaces.find((w: { slug: string }) => w.slug === slug);
  const channels = await request.get(`${API}/workspaces/${ws.id}/channels`, {
    headers: { authorization: `Bearer ${owner.accessToken}`, origin: ORIGIN },
  });
  const target = (await channels.json()).uncategorized.find((c: { name: string }) => c.name === ch1);
  const del = await request.delete(`${API}/workspaces/${ws.id}/channels/${target.id}`, {
    headers: { authorization: `Bearer ${owner.accessToken}`, origin: ORIGIN },
  });
  expect(del.status()).toBe(202);

  await page.reload();
  await expect(page.getByTestId(`channel-${ch1}`)).toHaveCount(0);
  await expect(page.getByTestId(`channel-${ch2}`)).toBeVisible();
});
