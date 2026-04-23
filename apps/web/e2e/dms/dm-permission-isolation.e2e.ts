import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

/**
 * task-027 CRITICAL invariant: workspace OWNER (who founded the
 * workspace) MUST NOT be able to read a DM channel between two other
 * members. The DM access guard bypasses the role-based OWNER override
 * and requires the explicit USER-level ALLOW on the channel.
 */
test('DM channel is 403 CHANNEL_NOT_VISIBLE even to workspace OWNER', async ({ request }) => {
  const stamp = Date.now();
  const slug = `dmp-${stamp.toString(36)}`;

  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmp-owner-${stamp}@qufox.dev`, username: `dmpo${stamp}`, password: PW },
  });
  const ownerToken = ((await owner.json()) as { accessToken: string }).accessToken;
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmp-a-${stamp}@qufox.dev`, username: `dmpa${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string; user: { id: string } };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmp-b-${stamp}@qufox.dev`, username: `dmpb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'DMP', slug },
  });
  const wsId = ((await ws.json()) as { id: string }).id;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: {},
  });
  const invCode = ((await inv.json()) as { code: string }).code;
  for (const t of [aBody.accessToken, bBody.accessToken]) {
    await request.post(`${API}/invites/${invCode}/accept`, {
      headers: { authorization: `Bearer ${t}`, origin: ORIGIN },
    });
  }

  const dm = await request.post(`${API}/me/dms`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { userId: bBody.user.id },
  });
  const dmChId = ((await dm.json()) as { channelId: string }).channelId;

  // Owner tries to read the DM channel's messages → must get 403.
  const res = await request.get(`${API}/workspaces/${wsId}/channels/${dmChId}/messages`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
  });
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.errorCode).toBe('CHANNEL_NOT_VISIBLE');
});
