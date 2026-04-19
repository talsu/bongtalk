import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('Ctrl+K palette + Alt+ArrowDown cycles channels', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `kbs-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `kbs-${stamp}@qufox.dev`, username: `kbs${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'KB', slug },
  });
  const wsId = (await ws.json()).id as string;
  for (const name of ['aa', 'bb', 'cc']) {
    await request.post(`${API}/workspaces/${wsId}/channels`, {
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      data: { name, type: 'TEXT' },
    });
  }

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`kbs-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));

  // Go to first channel so Alt+ArrowDown has a current anchor.
  await page.getByTestId('channel-aa').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/aa`));

  // Close any composer focus first (keyboard shortcuts skip when focused on input).
  await page.keyboard.press('Escape');
  await page.locator('body').click();

  await page.keyboard.press('Alt+ArrowDown');
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/bb`));

  // Open Ctrl+K palette.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette-input')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette-input')).toBeHidden({ timeout: 2000 });
});
