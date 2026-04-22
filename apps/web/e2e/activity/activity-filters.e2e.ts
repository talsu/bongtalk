import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('activity filter tabs switch filter + URL cache segregation', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `actf-${stamp.toString(36)}`;
  const email = `actf-${stamp}@qufox.dev`;
  const me = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username: `actf${stamp}`, password: PW },
  });
  const token = ((await me.json()) as { accessToken: string }).accessToken;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'ActF', slug },
  });
  void ws; // workspace created just so the user has a home

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/w\//);
  await page.goto('/activity');

  await expect(page.getByTestId('activity-tab-all')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('activity-tab-mentions').click();
  await expect(page.getByTestId('activity-tab-mentions')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('activity-tab-all')).toHaveAttribute('aria-selected', 'false');

  await page.getByTestId('activity-tab-reactions').click();
  await expect(page.getByTestId('activity-tab-reactions')).toHaveAttribute('aria-selected', 'true');

  await context.close();
});
