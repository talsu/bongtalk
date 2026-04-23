import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('block prevents friend request from blocked user', async ({ request }) => {
  const stamp = Date.now();
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `frb-a-${stamp}@qufox.dev`, username: `frba${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string; user: { id: string } };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `frb-b-${stamp}@qufox.dev`, username: `frbb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  const blk = await request.post(`${API}/me/friends/block/${bBody.user.id}`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
  });
  expect(blk.ok()).toBeTruthy();

  // Blocked target (B) cannot send a friend request to A (would be 403).
  const req = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
    data: { username: `frba${stamp}` },
  });
  expect(req.status()).toBe(403);

  // A's blocked list includes B.
  const list = await request.get(`${API}/me/friends?status=blocked`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
  });
  const items = (await list.json()) as { items: Array<{ otherUsername: string }> };
  expect(items.items.some((i) => i.otherUsername === `frbb${stamp}`)).toBe(true);
});
