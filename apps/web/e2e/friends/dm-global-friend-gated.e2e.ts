import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

/**
 * task-033-B: POST /me/dms (global) rejects non-friends and BLOCKED
 * pairs; ACCEPTED friendship lets it through.
 */
test('POST /me/dms is friend-gated — FRIEND_NOT_FOUND unless ACCEPTED', async ({ request }) => {
  const stamp = Date.now();
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmg-a-${stamp}@qufox.dev`, username: `dmga${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string; user: { id: string } };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmg-b-${stamp}@qufox.dev`, username: `dmgb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  // No friendship yet — 404 FRIEND_NOT_FOUND.
  const noFriend = await request.post(`${API}/me/dms`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { userId: bBody.user.id },
  });
  expect(noFriend.status()).toBe(404);
  expect((await noFriend.json()).errorCode).toBe('FRIEND_NOT_FOUND');

  // Create shared workspace so the Global DM can pick an implicit host.
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { name: 'Shared', slug: `sh-${stamp.toString(36)}` },
  });
  const wsBody = (await ws.json()) as { id: string };
  const inv = await request.post(`${API}/workspaces/${wsBody.id}/invites`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: {},
  });
  const code = ((await inv.json()) as { code: string }).code;
  await request.post(`${API}/invites/${code}/accept`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });

  // Friendship PENDING still insufficient — only ACCEPTED passes.
  const req = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { username: `dmgb${stamp}` },
  });
  const pendingId = ((await req.json()) as { id: string }).id;
  const pendingDm = await request.post(`${API}/me/dms`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { userId: bBody.user.id },
  });
  expect(pendingDm.status()).toBe(404);

  // Accept → DM works.
  await request.post(`${API}/me/friends/${pendingId}/accept`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });
  const ok = await request.post(`${API}/me/dms`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { userId: bBody.user.id },
  });
  expect(ok.ok()).toBeTruthy();
  const okBody = (await ok.json()) as { channelId: string };
  expect(okBody.channelId).toBeTruthy();
});
