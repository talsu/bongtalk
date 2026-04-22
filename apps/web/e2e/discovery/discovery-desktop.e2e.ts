import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('desktop /discover lists PUBLIC workspaces + category chips filter', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dd-o-${stamp}@qufox.dev`, username: `ddo${stamp}`, password: PW },
  });
  const ownerToken = ((await owner.json()) as { accessToken: string }).accessToken;
  const viewer = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dd-v-${stamp}@qufox.dev`, username: `ddv${stamp}`, password: PW },
  });
  const viewerToken = ((await viewer.json()) as { accessToken: string }).accessToken;
  void viewerToken;

  const slug = `pub-${stamp.toString(36)}`;
  await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: {
      name: 'Desktop Pub',
      slug,
      visibility: 'PUBLIC',
      category: 'PROGRAMMING',
      description: 'Desktop test public ws',
    },
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(`dd-v-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/(w\/new|$)/);
  await page.goto('/discover');

  await expect(page.getByTestId('discover-page')).toBeVisible();
  await expect(page.getByTestId(`discover-card-${slug}`)).toBeVisible();

  await page.getByTestId('discover-cat-PROGRAMMING').click();
  await expect(page.getByTestId(`discover-card-${slug}`)).toBeVisible();

  await page.getByTestId('discover-cat-GAMING').click();
  await expect(page.getByTestId(`discover-card-${slug}`)).toHaveCount(0);

  await context.close();
});
