import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('archive channel → updates rejected with 409 → unarchive allows updates again', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `ch-arc-${stamp.toString(36)}`;
  const email = `charc-${stamp}@qufox.dev`;
  const username = `charc${stamp}`;

  // Setup via UI: signup + create workspace
  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-username').fill(username);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(username);

  await page.goto('/w/new');
  await page.getByTestId('ws-name').fill('Archive');
  await page.getByTestId('ws-slug').fill(slug);
  await page.getByTestId('ws-create-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));

  const channelName = `to-archive-${stamp.toString(36)}`;
  await page.getByTestId('new-channel-name').fill(channelName);
  await page.getByTestId('new-channel-submit').click();
  await expect(page.getByTestId(`channel-${channelName}`)).toBeVisible();

  // Archive + patch + unarchive via API
  const login = await request.post(`${API}/auth/login`, {
    headers: { origin: ORIGIN },
    data: { email, password: PW },
  });
  const owner = await login.json();
  const list = await request.get(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });
  const ws = (await list.json()).workspaces.find((w: { slug: string }) => w.slug === slug);
  const channels = await request.get(`${API}/workspaces/${ws.id}/channels`, {
    headers: { authorization: `Bearer ${owner.accessToken}`, origin: ORIGIN },
  });
  const target = (await channels.json()).uncategorized.find(
    (c: { name: string }) => c.name === channelName,
  );

  const archive = await request.post(`${API}/workspaces/${ws.id}/channels/${target.id}/archive`, {
    headers: { authorization: `Bearer ${owner.accessToken}`, origin: ORIGIN },
  });
  expect(archive.status()).toBe(201);

  const blocked = await request.patch(`${API}/workspaces/${ws.id}/channels/${target.id}`, {
    headers: { authorization: `Bearer ${owner.accessToken}`, origin: ORIGIN },
    data: { topic: 'nope' },
  });
  expect(blocked.status()).toBe(409);
  const body = await blocked.json();
  expect(body.errorCode).toBe('CHANNEL_ARCHIVED');

  const unarchive = await request.post(
    `${API}/workspaces/${ws.id}/channels/${target.id}/unarchive`,
    {
      headers: { authorization: `Bearer ${owner.accessToken}`, origin: ORIGIN },
    },
  );
  expect(unarchive.status()).toBe(201);

  const allowed = await request.patch(`${API}/workspaces/${ws.id}/channels/${target.id}`, {
    headers: { authorization: `Bearer ${owner.accessToken}`, origin: ORIGIN },
    data: { topic: 'ok' },
  });
  expect(allowed.status()).toBe(200);
  expect((await allowed.json()).topic).toBe('ok');
});
