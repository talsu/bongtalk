import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('friend reject removes the PENDING row; re-request works', async ({ request }) => {
  const stamp = Date.now();
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `frj-a-${stamp}@qufox.dev`, username: `frja${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `frj-b-${stamp}@qufox.dev`, username: `frjb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string };

  const req = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { username: `frjb${stamp}` },
  });
  const reqBody = (await req.json()) as { id: string };

  const reject = await request.post(`${API}/me/friends/${reqBody.id}/reject`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });
  expect(reject.status()).toBe(204);

  // B's incoming now empty.
  const inc = await request.get(`${API}/me/friends?status=pending_incoming`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });
  const items = (await inc.json()) as { items: unknown[] };
  expect(items.items.length).toBe(0);

  // A can re-request.
  const re = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { username: `frjb${stamp}` },
  });
  expect(re.ok()).toBeTruthy();
});
