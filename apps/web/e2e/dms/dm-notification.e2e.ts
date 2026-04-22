import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

test('DM message surfaces in recipient /dms list', async ({ request }) => {
  const stamp = Date.now();
  const slug = `dmn-${stamp.toString(36)}`;

  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmn-a-${stamp}@qufox.dev`, username: `dmna${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string; user: { id: string } };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmn-b-${stamp}@qufox.dev`, username: `dmnb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { name: 'DMN', slug },
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
  const dmCh = (await dm.json()) as { channelId: string };

  await request.post(`${API}/workspaces/${wsId}/channels/${dmCh.channelId}/messages`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { idempotencyKey: `dmn-${stamp}`, content: 'ping via dm' },
  });

  // B should see the DM in their list with unread = 1.
  const list = await request.get(`${API}/me/workspaces/${wsId}/dms`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });
  expect(list.ok()).toBeTruthy();
  const listBody = (await list.json()) as {
    items: Array<{ channelId: string; unreadCount: number; lastMessagePreview: string | null }>;
  };
  const row = listBody.items.find((i) => i.channelId === dmCh.channelId);
  expect(row).toBeTruthy();
  expect(row!.unreadCount).toBeGreaterThanOrEqual(1);
  expect(row!.lastMessagePreview).toContain('ping via dm');
});
