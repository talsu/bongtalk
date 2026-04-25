import { test, expect } from '@playwright/test';

/**
 * task-039-A regression spec for hot-fix `fb7f3fb` (RoomManager now
 * joins users to channels they have an ALLOW override on, including
 * private DIRECT channels). Verifies WS fanout end-to-end:
 *   - User A and B in two browser contexts.
 *   - A sends a DM message → B sees it without reload.
 *   - B replies → A sees it without reload.
 *
 * If `RoomManager.roomsForUser` regresses to "isPrivate=false only"
 * the recipient socket no longer joins the DM channel room, this
 * test starves on the second `expect` and fails clearly.
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
  const fid = ((await req.json()) as { id: string }).id;
  await request.post(`${API}/me/friends/${fid}/accept`, {
    headers: { authorization: `Bearer ${b.accessToken}`, origin: ORIGIN },
  });
}

async function loginUI(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
}

test('two contexts: A→B and B→A DM messages fan out via WS', async ({ browser, request }) => {
  const a = await signup(request, 'dra');
  const b = await signup(request, 'drb');
  await befriend(request, a, b);

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await Promise.all([loginUI(pageA, a.email), loginUI(pageB, b.email)]);
  await pageA.goto(`/dm/${b.userId}`);
  await pageB.goto(`/dm/${a.userId}`);

  await expect(pageA.getByTestId(`msg-column-${b.username}`)).toBeVisible({ timeout: 15_000 });
  await expect(pageB.getByTestId(`msg-column-${a.username}`)).toBeVisible({ timeout: 15_000 });

  // A → B
  const greeting = `from-A-${Date.now()}`;
  await pageA.getByTestId('msg-input').fill(greeting);
  await pageA.getByTestId('msg-input').press('Enter');
  await expect(pageB.getByText(greeting).first()).toBeVisible({ timeout: 10_000 });

  // B → A
  const reply = `from-B-${Date.now()}`;
  await pageB.getByTestId('msg-input').fill(reply);
  await pageB.getByTestId('msg-input').press('Enter');
  await expect(pageA.getByText(reply).first()).toBeVisible({ timeout: 10_000 });

  await Promise.all([ctxA.close(), ctxB.close()]);
});
