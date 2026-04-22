import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('PATCH visibility=PUBLIC requires category + description on merged state', async ({
  request,
}) => {
  const stamp = Date.now();
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `vt-o-${stamp}@qufox.dev`, username: `vto${stamp}`, password: PW },
  });
  const ownerToken = ((await owner.json()) as { accessToken: string }).accessToken;

  const priv = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'VtPriv', slug: `vt-${stamp.toString(36)}` },
  });
  const privBody = (await priv.json()) as { id: string };

  // Toggle PUBLIC without category/description → 422 VALIDATION_FAILED.
  const flip1 = await request.patch(`${API}/workspaces/${privBody.id}`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { visibility: 'PUBLIC' },
  });
  expect(flip1.status()).toBe(422);

  // With category + description — accepted.
  const flip2 = await request.patch(`${API}/workspaces/${privBody.id}`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { visibility: 'PUBLIC', category: 'MUSIC', description: 'good music' },
  });
  expect(flip2.ok()).toBeTruthy();
});
