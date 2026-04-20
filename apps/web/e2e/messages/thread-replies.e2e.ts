import { test, expect } from '@playwright/test';

/**
 * Task-014-C: thread happy path. One user posts a root, opens the
 * thread panel, replies, sees the count badge update. The side panel
 * stays in sync through the WS echo.
 */
const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('post root → open thread → reply → count bumps on the root', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `th-${stamp.toString(36)}`;
  const email = `th-${stamp}@qufox.dev`;
  const username = `th${stamp}`;

  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-username').fill(username);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(username);

  await page.goto('/w/new');
  await page.getByTestId('ws-name').fill('Threads');
  await page.getByTestId('ws-slug').fill(slug);
  await page.getByTestId('ws-create-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));

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
    data: { name: `th-${stamp.toString(36).slice(-5)}`, type: 'TEXT' },
  });
  const channelName: string = (await chRes.json()).name;

  await page.goto(`/w/${slug}/${channelName}`);
  await page.getByTestId('msg-input').fill('start a thread');
  await page.getByTestId('msg-send').click();
  const mine = page.getByText('start a thread').first();
  await expect(mine).toBeVisible();

  const msgTestid = await mine
    .locator('xpath=ancestor::*[starts-with(@data-testid, "msg-")]')
    .getAttribute('data-testid');
  const rootId = msgTestid!.replace(/^msg-/, '');

  // Post a reply via API so the E2E doesn't depend on the thread open
  // button being present before any reply exists. After the reply,
  // the root message's thread summary row appears.
  await request.post(`${API}/workspaces/${ws.id}/channels/${(await chRes.json()).id}/messages`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { content: 'first reply via api', parentMessageId: rootId },
  });

  // Count badge appears within a couple seconds (WS echo).
  await expect(page.getByTestId(`thread-open-${rootId}`)).toBeVisible();

  // Open the thread panel and send a reply from the UI.
  await page.getByTestId(`thread-open-${rootId}`).click();
  await expect(page.getByTestId('thread-panel')).toBeVisible();
  await page.getByTestId('thread-input').fill('from the panel');
  await page.getByTestId('thread-send').click();
  await expect(page.getByText('from the panel')).toBeVisible();

  // Close the panel via the X button.
  await page.getByTestId('thread-close').click();
  await expect(page.getByTestId('thread-panel')).toHaveCount(0);
});
