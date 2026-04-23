import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

/**
 * task-034-A regression: Global DM creates a workspaceless channel
 * (Channel.workspaceId IS NULL). No shared-workspace requirement —
 * two strangers who never joined the same workspace but are friends
 * can still DM globally.
 */
test('Global DM creates workspaceless Channel — no shared workspace needed', async ({
  request,
}) => {
  const stamp = Date.now();
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `wl-a-${stamp}@qufox.dev`, username: `wla${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string; user: { id: string } };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `wl-b-${stamp}@qufox.dev`, username: `wlb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  // Two fresh users, no shared workspace — friendship path only.
  const req = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { username: `wlb${stamp}` },
  });
  const reqId = ((await req.json()) as { id: string }).id;
  await request.post(`${API}/me/friends/${reqId}/accept`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });

  // Global DM via POST /me/dms — should succeed.
  const dm = await request.post(`${API}/me/dms`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { userId: bBody.user.id },
  });
  expect(dm.ok()).toBeTruthy();
  const dmBody = (await dm.json()) as { channelId: string; created: boolean };
  expect(dmBody.channelId).toBeTruthy();

  // Idempotent — second call returns the same channelId.
  const dm2 = await request.post(`${API}/me/dms`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { userId: bBody.user.id },
  });
  const dm2Body = (await dm2.json()) as { channelId: string; created: boolean };
  expect(dm2Body.channelId).toBe(dmBody.channelId);
  expect(dm2Body.created).toBe(false);
});
