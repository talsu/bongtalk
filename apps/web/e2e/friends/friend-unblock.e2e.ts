import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('unblock removes the BLOCKED row', async ({ request }) => {
  const stamp = Date.now();
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `frub-a-${stamp}@qufox.dev`, username: `fruba${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string; user: { id: string } };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `frub-b-${stamp}@qufox.dev`, username: `frubb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  await request.post(`${API}/me/friends/block/${bBody.user.id}`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
  });

  const un = await request.delete(`${API}/me/friends/block/${bBody.user.id}`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
  });
  expect(un.status()).toBe(204);

  const list = await request.get(`${API}/me/friends?status=blocked`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
  });
  const items = (await list.json()) as { items: unknown[] };
  expect(items.items.length).toBe(0);

  // B can now send a friend request again.
  const req = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
    data: { username: `fruba${stamp}` },
  });
  expect(req.ok()).toBeTruthy();
});
