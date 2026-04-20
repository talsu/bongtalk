import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('edit own message → shows (edited); delete → placeholder', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `ms-ed-${stamp.toString(36)}`;
  const email = `msed-${stamp}@qufox.dev`;
  const username = `msed${stamp}`;

  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-username').fill(username);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(username);

  await page.goto('/w/new');
  await page.getByTestId('ws-name').fill('Edit');
  await page.getByTestId('ws-slug').fill(slug);
  await page.getByTestId('ws-create-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));

  // Create channel via API for deterministic timing
  const loginRes = await request.post(`${API}/auth/login`, {
    headers: { origin: ORIGIN },
    data: { email, password: PW },
  });
  const token = (await loginRes.json()).accessToken as string;
  const list = await request.get(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const ws = (await list.json()).workspaces.find((w: { slug: string }) => w.slug === slug);
  const chRes = await request.post(`${API}/workspaces/${ws.id}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: `ed-${stamp.toString(36).slice(-5)}`, type: 'TEXT' },
  });
  const channelName: string = (await chRes.json()).name;

  await page.goto(`/w/${slug}/${channelName}`);
  await page.getByTestId('msg-input').fill('first draft');
  await page.getByTestId('msg-send').click();
  const mine = page.getByText('first draft').first();
  await expect(mine).toBeVisible();
  const msgId = await mine
    .locator('xpath=ancestor::*[starts-with(@data-testid, "msg-")]')
    .getAttribute('data-testid');
  expect(msgId).toBeTruthy();
  const idPart = msgId!.replace(/^msg-/, '');

  await page.getByTestId(`msg-edit-btn-${idPart}`).click();
  await page.getByTestId(`msg-edit-${idPart}`).fill('final version');
  await page.getByTestId(`msg-edit-save-${idPart}`).click();
  await expect(page.getByTestId(`msg-edited-${idPart}`)).toBeVisible();
  await expect(page.getByText('final version')).toBeVisible();

  await page.getByTestId(`msg-delete-${idPart}`).click();
  await expect(page.getByTestId(`msg-deleted-${idPart}`)).toBeVisible();
});
