import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('shell persists across channel switches (no unmount)', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `nav-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `nav-${stamp}@qufox.dev`, username: `nav${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'Nav', slug },
  });
  const wsId = (await ws.json()).id as string;
  for (const name of ['alpha', 'beta']) {
    await request.post(`${API}/workspaces/${wsId}/channels`, {
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      data: { name, type: 'TEXT' },
    });
  }

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`nav-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));

  // Shell root should exist before and after channel change (same DOM node).
  const shellBefore = await page.getByTestId('shell-root').elementHandle();
  await page.getByTestId('channel-alpha').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/alpha`));
  await page.getByTestId('channel-beta').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/beta`));
  const shellAfter = await page.getByTestId('shell-root').elementHandle();
  // React Router doesn't remount the same component at the same position,
  // so the DOM node is identical.
  expect(await shellBefore?.evaluate((a, b) => a === b, shellAfter)).toBe(true);
});
