import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

test('dm create flow: A searches B, starts DM, sends message, B receives', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `dm-${stamp.toString(36)}`;
  const aEmail = `dm-a-${stamp}@qufox.dev`;
  const bEmail = `dm-b-${stamp}@qufox.dev`;
  const aUser = `dma${stamp}`;
  const bUser = `dmb${stamp}`;

  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: aEmail, username: aUser, password: PW },
  });
  const aToken = ((await a.json()) as { accessToken: string }).accessToken;
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: bEmail, username: bUser, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
    data: { name: 'DMW', slug },
  });
  const wsId = ((await ws.json()) as { id: string }).id;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
    data: {},
  });
  const invCode = ((await inv.json()) as { code: string }).code;
  await request.post(`${API}/invites/${invCode}/accept`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(aEmail);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/w\//);

  await page.goto(`/w/${slug}/dm`);
  await expect(page.getByTestId('dm-list-page')).toBeVisible();
  await page.getByTestId('dm-new-btn').click();
  await page.getByTestId('dm-new-search').fill(bUser);
  await page.getByTestId(`dm-new-candidate-${bUser}`).click();
  await page.waitForURL(new RegExp(`/w/${slug}/dm/${bBody.user.id}`));

  await page.getByTestId('msg-input').fill('hello dm');
  await page.getByTestId('msg-send').click();
  await expect(page.getByText('hello dm')).toBeVisible();

  await context.close();
});
