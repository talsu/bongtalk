import { test, expect } from '@playwright/test';

/**
 * task-039-A regression spec for hot-fix series `a425a3c` /
 * `c5146ff` / `712e199` / `e678195` / `58a785c`. End-to-end
 * Global DM flow on desktop AND mobile (375x667 viewport):
 *   - signup two users + befriend over the API
 *   - desktop: open /dm, pick the friend, send a message,
 *     reload, expect history to come back
 *   - mobile: same flow via /dms list → /dms/:userId chat
 *   - URL must NOT contain a workspaceId segment
 */

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(120_000);

async function signup(request: import('@playwright/test').APIRequestContext, prefix: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 99999)}`;
  const email = `${prefix}-${stamp}@qufox.dev`;
  const username = `${prefix}${stamp}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username, password: PW },
  });
  if (!res.ok()) throw new Error(`signup failed: ${res.status()}`);
  const body = (await res.json()) as { accessToken: string; user: { id: string } };
  return { email, username, userId: body.user.id, accessToken: body.accessToken };
}

async function befriend(
  request: import('@playwright/test').APIRequestContext,
  a: { accessToken: string },
  b: { accessToken: string; username: string },
) {
  const req = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
    data: { username: b.username },
  });
  const friendshipId = ((await req.json()) as { id: string }).id;
  await request.post(`${API}/me/friends/${friendshipId}/accept`, {
    headers: { authorization: `Bearer ${b.accessToken}`, origin: ORIGIN },
  });
}

async function loginUI(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
}

test('desktop: workspaceless DM send + history survives reload', async ({ browser, request }) => {
  const a = await signup(request, 'dwa');
  const b = await signup(request, 'dwb');
  await befriend(request, a, b);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await loginUI(page, a.email);
  await page.goto('/dm');
  await expect(page.getByTestId('dm-shell-root')).toBeVisible();

  // Click the friend in the side panel.
  await page.getByTestId(`dm-side-friend-${b.username}`).click();
  await expect(page).toHaveURL(new RegExp(`/dm/${b.userId}$`));
  // URL must not be workspace-scoped.
  expect(page.url()).not.toMatch(/\/w\//);

  // Wait for the message column to mount.
  await expect(page.getByTestId(`msg-column-${b.username}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('msg-input').fill('hello workspaceless');
  await page.getByTestId('msg-input').press('Enter');
  await expect(page.getByText('hello workspaceless').first()).toBeVisible();

  // Reload — history should still be there.
  await page.reload();
  await expect(page.getByText('hello workspaceless').first()).toBeVisible({ timeout: 15_000 });
  expect(page.url()).not.toMatch(/\/w\//);
  await ctx.close();
});

test('mobile (375x667): same flow via /dms list', async ({ browser, request }) => {
  const a = await signup(request, 'dwma');
  const b = await signup(request, 'dwmb');
  await befriend(request, a, b);

  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await ctx.newPage();
  await loginUI(page, a.email);
  // Mobile lands on /dm too post-038 hot-fix d72b606.
  await page.goto('/dms');
  await expect(page.getByTestId('mobile-dm-list')).toBeVisible();

  await page.getByTestId('mobile-dm-fab-new').click();
  await page.getByTestId(`mobile-dm-new-candidate-${b.username}`).click();
  // Mobile chat URL — no workspace segment.
  await expect(page).toHaveURL(new RegExp(`/dms/${b.userId}`));
  expect(page.url()).not.toMatch(/\/w\//);
  await expect(page.getByTestId('mobile-dm-chat')).toBeVisible();

  await page.getByTestId('mobile-msg-input').fill('hello mobile workspaceless');
  await page.getByTestId('mobile-composer-send').click();
  await expect(page.getByText('hello mobile workspaceless').first()).toBeVisible({
    timeout: 15_000,
  });

  // task-039 review MED-2: explicitly cover the regression that hot-fix
  // c5146ff targeted (useMessageHistory enabled gate skipping null
  // workspaceId). After reload the mobile chat must still surface the
  // history just sent.
  await page.reload();
  await expect(page.getByText('hello mobile workspaceless').first()).toBeVisible({
    timeout: 15_000,
  });
  expect(page.url()).not.toMatch(/\/w\//);
  await ctx.close();
});
