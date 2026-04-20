import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('user can flip to DnD from the BottomBar profile menu (task-019-C)', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `dnd-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dnd-${stamp}@qufox.dev`, username: `dnd${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'DnDWs', slug },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`dnd-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));

  const trigger = page.getByTestId('presence-status-trigger');
  await expect(trigger).toHaveAttribute('data-presence', 'online');

  await trigger.click();
  await page.getByTestId('presence-set-dnd').click();

  await expect(trigger).toHaveAttribute('data-presence', 'dnd');
  await expect(page.getByTestId('home-status')).toHaveText('방해 금지');
});
