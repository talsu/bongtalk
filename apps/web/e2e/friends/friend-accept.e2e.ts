import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('friend accept moves PENDING → ACCEPTED for both users', async ({ request }) => {
  const stamp = Date.now();
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `fra-a-${stamp}@qufox.dev`, username: `fraa${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `fra-b-${stamp}@qufox.dev`, username: `frab${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string };

  const req = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { username: `frab${stamp}` },
  });
  const reqBody = (await req.json()) as { id: string };

  const accept = await request.post(`${API}/me/friends/${reqBody.id}/accept`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });
  expect(accept.ok()).toBeTruthy();
  const acceptBody = (await accept.json()) as { status: string };
  expect(acceptBody.status).toBe('ACCEPTED');

  // Both sides see each other under 'accepted'.
  for (const token of [aBody.accessToken, bBody.accessToken]) {
    const list = await request.get(`${API}/me/friends?status=accepted`, {
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    });
    const items = (await list.json()) as { items: Array<{ status: string }> };
    expect(items.items.some((i) => i.status === 'ACCEPTED')).toBe(true);
  }
});
