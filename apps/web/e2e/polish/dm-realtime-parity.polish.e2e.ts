import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

/**
 * task-028 polish harness: DM channels must receive realtime
 * message append events the same way regular channels do. Here we
 * send via one user and confirm the channel-scoped list endpoint
 * reflects the message for the other.
 */
test('DM channel gets message append via channel-scoped list endpoint (parity with regular channels)', async ({
  request,
}) => {
  const stamp = Date.now();
  const slug = `dmrt-${stamp.toString(36)}`;
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmrt-a-${stamp}@qufox.dev`, username: `dmrta${stamp}`, password: PW },
  });
  const aBody = (await a.json()) as { accessToken: string; user: { id: string } };
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmrt-b-${stamp}@qufox.dev`, username: `dmrtb${stamp}`, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { name: 'DMrt', slug },
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

  const dm = await request.post(`${API}/me/dms`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { userId: bBody.user.id },
  });
  const dmCh = ((await dm.json()) as { channelId: string }).channelId;

  await request.post(`${API}/workspaces/${wsId}/channels/${dmCh}/messages`, {
    headers: { authorization: `Bearer ${aBody.accessToken}`, origin: ORIGIN },
    data: { idempotencyKey: `dmrt-${stamp}`, content: 'rt parity' },
  });

  // B should see the message in the channel's list (same endpoint as regular channels).
  const hist = await request.get(`${API}/workspaces/${wsId}/channels/${dmCh}/messages?limit=10`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });
  expect(hist.ok()).toBeTruthy();
  const body = (await hist.json()) as { items: Array<{ content: string | null }> };
  expect(body.items.some((i) => (i.content ?? '').includes('rt parity'))).toBe(true);
});
