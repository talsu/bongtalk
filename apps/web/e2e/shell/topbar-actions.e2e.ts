import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('topbar renders search input, disabled pin, and member toggle (task-018-B)', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `topbar-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `topbar-${stamp}@qufox.dev`, username: `tb${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'Topbar', slug },
  });
  const wsId = (await ws.json()).id as string;
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT', topic: '공지 · 일반 대화' },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`topbar-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
  await page.getByTestId('channel-general').click();

  const topicCell = page.locator('.qf-topbar__topic');
  await expect(topicCell).toHaveText('공지 · 일반 대화');

  await page.getByTestId('topbar-pin').hover();
  await expect(page.getByTestId('topbar-pin')).toBeDisabled();

  await page.getByTestId('topbar-search').click();
  await expect(page.getByTestId('search-input')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search-input')).not.toBeVisible();

  const memberCol = page.getByTestId('member-column');
  await expect(memberCol).toBeVisible();
  await page.getByTestId('topbar-members-toggle').click();
  await expect(memberCol).not.toBeVisible();
  await page.getByTestId('topbar-members-toggle').click();
  await expect(memberCol).toBeVisible();
});
