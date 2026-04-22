import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

/**
 * task-028 polish harness: the DM list is sorted by last-message
 * desc (nulls last). When a fresh message arrives, the peer that
 * received it must move to the top of the ordered list.
 */
test('DM list re-orders by last-activity desc when new message arrives', async ({ request }) => {
  const stamp = Date.now();
  const slug = `dmls-${stamp.toString(36)}`;
  const me = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmls-me-${stamp}@qufox.dev`, username: `dmlsme${stamp}`, password: PW },
  });
  const meBody = (await me.json()) as { accessToken: string; user: { id: string } };
  const p1 = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmls-p1-${stamp}@qufox.dev`, username: `dmlsp1${stamp}`, password: PW },
  });
  const p1Body = (await p1.json()) as { accessToken: string; user: { id: string } };
  const p2 = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dmls-p2-${stamp}@qufox.dev`, username: `dmlsp2${stamp}`, password: PW },
  });
  const p2Body = (await p2.json()) as { accessToken: string; user: { id: string } };

  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: { name: 'DMls', slug },
  });
  const wsId = ((await ws.json()) as { id: string }).id;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: {},
  });
  const invCode = ((await inv.json()) as { code: string }).code;
  for (const t of [p1Body.accessToken, p2Body.accessToken]) {
    await request.post(`${API}/invites/${invCode}/accept`, {
      headers: { authorization: `Bearer ${t}`, origin: ORIGIN },
    });
  }

  // Open two DMs; only p2 has a message, so p2 must appear first.
  const dm1 = await request.post(`${API}/me/workspaces/${wsId}/dms`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: { userId: p1Body.user.id },
  });
  const dm1Ch = ((await dm1.json()) as { channelId: string }).channelId;
  const dm2 = await request.post(`${API}/me/workspaces/${wsId}/dms`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: { userId: p2Body.user.id },
  });
  const dm2Ch = ((await dm2.json()) as { channelId: string }).channelId;

  await request.post(`${API}/workspaces/${wsId}/channels/${dm2Ch}/messages`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: { idempotencyKey: `dmls-${stamp}`, content: 'ranking bump' },
  });

  const list = await request.get(`${API}/me/workspaces/${wsId}/dms`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
  });
  const body = (await list.json()) as { items: Array<{ channelId: string }> };
  // p2 with recent message should come before p1 (no messages).
  const idxP2 = body.items.findIndex((i) => i.channelId === dm2Ch);
  const idxP1 = body.items.findIndex((i) => i.channelId === dm1Ch);
  expect(idxP2).toBeGreaterThanOrEqual(0);
  expect(idxP1).toBeGreaterThanOrEqual(0);
  expect(idxP2).toBeLessThan(idxP1);
});
