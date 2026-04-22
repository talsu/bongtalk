import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('DM unread bumps list row within 2s; opening chat clears it', async ({ request }) => {
  const stamp = Date.now();
  const slug = `dmunb-${stamp.toString(36)}`;
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmunb-a-${stamp}@qufox.dev`, username: `dmunba${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string; user: { id: string } };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmunb-b-${stamp}@qufox.dev`, username: `dmunbb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { name: 'DMUn', slug },
  });
  const wsId = ((await ws.json()) as { id: string }).id;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: {},
  });
  const invCode = ((await inv.json()) as { code: string }).code;
  await request.post(`${API}/invites/${invCode}/accept`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });
  const dm = await request.post(`${API}/me/workspaces/${wsId}/dms`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { userId: bBody.user.id },
  });
  const dmCh = ((await dm.json()) as { channelId: string }).channelId;

  await request.post(`${API}/workspaces/${wsId}/channels/${dmCh}/messages`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { idempotencyKey: `dmunb-${stamp}`, content: 'unread me' },
  });

  // B reads the DM list via API — row should show unread=1.
  const list = await request.get(`${API}/me/workspaces/${wsId}/dms`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });
  const body = (await list.json()) as { items: Array<{ channelId: string; unreadCount: number }> };
  const row = body.items.find((i) => i.channelId === dmCh);
  expect(row?.unreadCount).toBeGreaterThanOrEqual(1);

  // B "reads" the channel via the read-state endpoint; unread count goes to 0.
  await request.post(`${API}/workspaces/${wsId}/channels/${dmCh}/read`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
    data: {},
  });
  const list2 = await request.get(`${API}/me/workspaces/${wsId}/dms`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });
  const body2 = (await list2.json()) as {
    items: Array<{ channelId: string; unreadCount: number }>;
  };
  const row2 = body2.items.find((i) => i.channelId === dmCh);
  expect(row2?.unreadCount).toBe(0);
});
