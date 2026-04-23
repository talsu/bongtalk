import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('POST /me/friends/requests creates PENDING + target sees incoming', async ({ request }) => {
  const stamp = Date.now();
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `frs-a-${stamp}@qufox.dev`, username: `frsa${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string; user: { id: string } };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `frs-b-${stamp}@qufox.dev`, username: `frsb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  const res = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { username: `frsb${stamp}` },
  });
  expect(res.ok()).toBeTruthy();

  // B's incoming list includes the request.
  const incoming = await request.get(`${API}/me/friends?status=pending_incoming`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });
  const ibody = (await incoming.json()) as {
    items: Array<{ otherUsername: string; direction: string }>;
  };
  expect(
    ibody.items.some((i) => i.otherUsername === `frsa${stamp}` && i.direction === 'incoming'),
  ).toBe(true);

  // Duplicate request → 409.
  const dup = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { username: `frsb${stamp}` },
  });
  expect(dup.status()).toBe(409);

  // Self request → 400.
  const self = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { username: `frsa${stamp}` },
  });
  expect(self.status()).toBe(400);
});
