import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('createOrGet is idempotent — second request returns same channelId', async ({ request }) => {
  const stamp = Date.now();
  const slug = `dmre-${stamp.toString(36)}`;
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmre-a-${stamp}@qufox.dev`, username: `dmrea${stamp}`, password: PW },
  });
  const aToken = ((await a.json()) as { accessToken: string }).accessToken;
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmre-b-${stamp}@qufox.dev`, username: `dmreb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
    data: { name: 'DMRe', slug },
  });
  const wsId = ((await ws.json()) as { id: string }).id;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
    data: {},
  });
  const invCode = ((await inv.json()) as { code: string }).code;
  await request.post(`${API}/invites/${invCode}/accept`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });

  const first = await request.post(`${API}/me/dms`, {
    headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
    data: { userId: bBody.user.id },
  });
  expect(first.ok()).toBeTruthy();
  const firstBody = (await first.json()) as { channelId: string; created: boolean };
  expect(firstBody.created).toBe(true);

  const second = await request.post(`${API}/me/dms`, {
    headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
    data: { userId: bBody.user.id },
  });
  expect(second.ok()).toBeTruthy();
  const secondBody = (await second.json()) as { channelId: string; created: boolean };
  expect(secondBody.channelId).toBe(firstBody.channelId);
  expect(secondBody.created).toBe(false);
});
