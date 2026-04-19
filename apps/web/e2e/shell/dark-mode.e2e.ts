import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('dark mode toggle + reload persistence', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `dm-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dm-${stamp}@qufox.dev`, username: `dm${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'DM', slug },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`dm-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));

  const html = page.locator('html');
  const before = await html.getAttribute('data-theme');
  await page.getByTestId('theme-toggle').click();
  const after = await html.getAttribute('data-theme');
  expect(after).not.toBe(before);

  // Reload and verify persistence.
  await page.reload();
  const persisted = await html.getAttribute('data-theme');
  expect(persisted).toBe(after);
});
