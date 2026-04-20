import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);
test('typing indicator: A types → B sees qf-typing with A; stop → clears (task-018-F)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `typing-${stamp.toString(36)}`;
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `owner-${stamp}@qufox.dev`, username: `owner${stamp}`, password: PW },
  });
  const ownerToken = (await owner.json()).accessToken as string;

  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'Typing', slug },
  });
  const wsId = (await ws.json()).id as string;
  const ch = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const chId = (await ch.json()).id as string;
  void chId;

  const peer = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `peer-${stamp}@qufox.dev`, username: `peer${stamp}`, password: PW },
  });
  const peerToken = (await peer.json()).accessToken as string;
  const invite = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const code = (await invite.json()).invite?.code ?? (await invite.json()).code;
  await request.post(`${API}/invites/${code}/accept`, {
    headers: { authorization: `Bearer ${peerToken}`, origin: ORIGIN },
  });

  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto('/login');
  await pageA.getByTestId('login-email').fill(`owner-${stamp}@qufox.dev`);
  await pageA.getByTestId('login-password').fill(PW);
  await pageA.getByTestId('login-submit').click();
  await expect(pageA).toHaveURL(new RegExp(`/w/${slug}`));
  await pageA.getByTestId('channel-general').click();

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/login');
  await pageB.getByTestId('login-email').fill(`peer-${stamp}@qufox.dev`);
  await pageB.getByTestId('login-password').fill(PW);
  await pageB.getByTestId('login-submit').click();
  await expect(pageB).toHaveURL(new RegExp(`/w/${slug}`));
  await pageB.getByTestId('channel-general').click();

  await pageA.getByTestId('msg-input').fill('typing away…');

  const indicator = pageB.locator('.qf-typing');
  await expect(indicator).toContainText(`owner${stamp}`, { timeout: 4000 });

  await pageA.getByTestId('msg-input').fill('');
  await expect(indicator).toHaveCount(0, { timeout: 8000 });
});
