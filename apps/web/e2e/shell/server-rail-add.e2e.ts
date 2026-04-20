import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('server rail + button navigates to /w/new (task-018-E)', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `rail-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `rail-${stamp}@qufox.dev`, username: `rail${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'Rail', slug },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`rail-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));

  const addBtn = page.getByTestId('ws-nav-new');
  await expect(addBtn).toHaveAttribute('aria-label', '워크스페이스 추가');
  await addBtn.click();
  await expect(page).toHaveURL(/\/w\/new$/);
});
