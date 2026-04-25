import { test, expect } from '@playwright/test';

/**
 * task-039-B regression spec for hot-fix `bebfd20` + `538bbda`. The
 * "+" button on the server rail should open the DS Dialog (not
 * navigate to a standalone /w/new page) and present the fields in
 * the agreed order. Description is always visible.
 */

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

async function signup(request: import('@playwright/test').APIRequestContext) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 99999)}`;
  const email = `wcd-${stamp}@qufox.dev`;
  const username = `wcd${stamp}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username, password: PW },
  });
  const body = (await res.json()) as { accessToken: string; user: { id: string } };
  return { email, username, userId: body.user.id, accessToken: body.accessToken };
}

test('+ button opens DS Dialog with name/slug/description/visibility/category order', async ({
  browser,
  request,
}) => {
  const u = await signup(request);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(u.email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/dm');

  // Stay on the same URL — clicking + opens an overlay, no navigate.
  const beforeUrl = page.url();
  await page.getByTestId('ws-nav-new').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(page.url()).toBe(beforeUrl);

  // Field order: name → slug → description → visibility (toggle) → category
  // (category is conditional on PUBLIC).
  const dialog = page.getByRole('dialog');
  const nameY = await dialog.getByTestId('ws-name').boundingBox();
  const slugY = await dialog.getByTestId('ws-slug').boundingBox();
  const descY = await dialog.getByTestId('ws-description').boundingBox();
  const togY = await dialog.getByTestId('ws-visibility-public').boundingBox();
  expect(nameY?.y).toBeLessThan(slugY?.y ?? 0);
  expect(slugY?.y).toBeLessThan(descY?.y ?? 0);
  expect(descY?.y).toBeLessThan(togY?.y ?? 0);

  // Description always visible regardless of visibility — already
  // measured above (it sits between slug and visibility).
  await expect(dialog.getByTestId('ws-description')).toBeVisible();

  // Toggle public → category should appear AFTER the toggle.
  await dialog.getByTestId('ws-visibility-public').click();
  await expect(dialog.getByTestId('ws-category')).toBeVisible();
  const catY = await dialog.getByTestId('ws-category').boundingBox();
  expect(togY?.y).toBeLessThan(catY?.y ?? 0);

  await ctx.close();
});

test('public visibility requires category — submit blocks with empty category', async ({
  browser,
  request,
}) => {
  const u = await signup(request);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(u.email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/dm');

  await page.getByTestId('ws-nav-new').click();
  const stamp = Date.now().toString(36);
  await page.getByTestId('ws-name').fill('Pub Ws');
  await page.getByTestId('ws-slug').fill(`pub-${stamp}`);
  await page.getByTestId('ws-description').fill('public ws description');
  // Flip to public.
  await page.getByTestId('ws-visibility-public').click();
  // Don't pick a category — submit should fail validation.
  await page.getByTestId('ws-create-submit').click();
  // Dialog stays open (validation failed) and category select still in DOM.
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByTestId('ws-category')).toBeVisible();
  await ctx.close();
});

test('private visibility allows empty category and creates workspace', async ({
  browser,
  request,
}) => {
  const u = await signup(request);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(u.email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/dm');

  const stamp = Date.now().toString(36);
  await page.getByTestId('ws-nav-new').click();
  await page.getByTestId('ws-name').fill('Priv Ws');
  await page.getByTestId('ws-slug').fill(`priv-${stamp}`);
  // Description optional but allowed even on private.
  await page.getByTestId('ws-description').fill('private workspace');
  await page.getByTestId('ws-create-submit').click();
  await page.waitForURL(new RegExp(`/w/priv-${stamp}`));
  await ctx.close();
});
