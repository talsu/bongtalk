import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-021 polish harness — typing indicator accuracy.
 *
 * Scenarios:
 * 1. A types then clears all text → B's qf-typing clears within 2s
 *    (no 5s TTL wait).
 * 2. A types then closes tab → B's qf-typing clears within 5s
 *    (disconnect-driven, covered by 018-F typingService.dropForUser).
 */

test.setTimeout(90_000);
test('polish: typing clears immediately when A empties the draft (R1-typing-stale-on-clear)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `polt-${stamp.toString(36)}`;
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polt-o-${stamp}@qufox.dev`, username: `polto${stamp}`, password: PW },
  });
  const ownerToken = (await owner.json()).accessToken as string;
  const ownerUsername = `polto${stamp}`;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'PolishTyping', slug },
  });
  const wsId = (await ws.json()).id as string;
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const peer = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polt-p-${stamp}@qufox.dev`, username: `poltp${stamp}`, password: PW },
  });
  const peerToken = (await peer.json()).accessToken as string;
  const invite = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const inviteBody = await invite.json();
  const code = inviteBody.invite?.code ?? inviteBody.code;
  await request.post(`${API}/invites/${code}/accept`, {
    headers: { authorization: `Bearer ${peerToken}`, origin: ORIGIN },
  });

  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto('/login');
  await pageA.getByTestId('login-email').fill(`polt-o-${stamp}@qufox.dev`);
  await pageA.getByTestId('login-password').fill(PW);
  await pageA.getByTestId('login-submit').click();
  await expect(pageA).toHaveURL(new RegExp(`/w/${slug}`));
  await pageA.getByTestId('channel-general').click();

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/login');
  await pageB.getByTestId('login-email').fill(`polt-p-${stamp}@qufox.dev`);
  await pageB.getByTestId('login-password').fill(PW);
  await pageB.getByTestId('login-submit').click();
  await expect(pageB).toHaveURL(new RegExp(`/w/${slug}`));
  await pageB.getByTestId('channel-general').click();

  await pageA.getByTestId('msg-input').fill('hello');
  const indicator = pageB.locator('.qf-typing');
  await expect(indicator).toContainText(ownerUsername, { timeout: 4000 });

  // POLISH: clearing the textarea should stop the indicator within 2s,
  // not wait for the 5s server TTL.
  await pageA.getByTestId('msg-input').fill('');
  await expect(indicator).toHaveCount(0, { timeout: 2500 });
});

test('polish: typing clears within 5s after tab close (R1-typing-stale-on-tab-close)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now() + 1;
  const slug = `poltc-${stamp.toString(36)}`;
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: {
      email: `poltc-o-${stamp}@qufox.dev`,
      username: `poltco${stamp}`,
      password: PW,
    },
  });
  const ownerToken = (await owner.json()).accessToken as string;
  const ownerUsername = `poltco${stamp}`;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'PolishTabClose', slug },
  });
  const wsId = (await ws.json()).id as string;
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const peer = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: {
      email: `poltc-p-${stamp}@qufox.dev`,
      username: `poltcp${stamp}`,
      password: PW,
    },
  });
  const peerToken = (await peer.json()).accessToken as string;
  const invite = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const inviteBody = await invite.json();
  const code = inviteBody.invite?.code ?? inviteBody.code;
  await request.post(`${API}/invites/${code}/accept`, {
    headers: { authorization: `Bearer ${peerToken}`, origin: ORIGIN },
  });

  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto('/login');
  await pageA.getByTestId('login-email').fill(`poltc-o-${stamp}@qufox.dev`);
  await pageA.getByTestId('login-password').fill(PW);
  await pageA.getByTestId('login-submit').click();
  await expect(pageA).toHaveURL(new RegExp(`/w/${slug}`));
  await pageA.getByTestId('channel-general').click();

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/login');
  await pageB.getByTestId('login-email').fill(`poltc-p-${stamp}@qufox.dev`);
  await pageB.getByTestId('login-password').fill(PW);
  await pageB.getByTestId('login-submit').click();
  await expect(pageB).toHaveURL(new RegExp(`/w/${slug}`));
  await pageB.getByTestId('channel-general').click();

  await pageA.getByTestId('msg-input').fill('hello');
  const indicator = pageB.locator('.qf-typing');
  await expect(indicator).toContainText(ownerUsername, { timeout: 4000 });

  // Force-close A's context — simulates tab close / process death.
  await ctxA.close();

  // 018-F backend disconnect hook should SREM A from typing set AND
  // re-broadcast. B sees typing clear within ~5s.
  await expect(indicator).toHaveCount(0, { timeout: 7000 });
});
