import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

/**
 * task-028 polish harness: Activity inbox live-update. After a
 * mention + reaction + reply are posted, the recipient's
 * /me/activity feed returns all three within a single page.
 * Covers the UNION query correctness that the 026 dispatcher then
 * invalidates into the React Query cache.
 */
test('Activity inbox surfaces mention + reply + reaction rows', async ({ request }) => {
  const stamp = Date.now();
  const slug = `actlu-${stamp.toString(36)}`;
  const me = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `actlu-me-${stamp}@qufox.dev`, username: `actlume${stamp}`, password: PW },
  });
  const meBody = (await me.json()) as { accessToken: string; user: { id: string } };
  const actor = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `actlu-act-${stamp}@qufox.dev`, username: `actluact${stamp}`, password: PW },
  });
  const actorBody = (await actor.json()) as { accessToken: string; user: { id: string } };
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: { name: 'ActLu', slug },
  });
  const wsId = ((await ws.json()) as { id: string }).id;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: {},
  });
  const invCode = ((await inv.json()) as { code: string }).code;
  await request.post(`${API}/invites/${invCode}/accept`, {
    headers: { authorization: `Bearer ${actorBody.accessToken}`, origin: ORIGIN },
  });
  const ch = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const chId = ((await ch.json()) as { id: string }).id;

  // Me posts a root.
  const root = await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: { idempotencyKey: `actlu-root-${stamp}`, content: 'root by me' },
  });
  const rootId = ((await root.json()) as { id: string }).id;

  // Actor mentions me.
  await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
    headers: { authorization: `Bearer ${actorBody.accessToken}`, origin: ORIGIN },
    data: {
      idempotencyKey: `actlu-m-${stamp}`,
      content: `<@${meBody.user.id}> ping`,
      mentions: { users: [meBody.user.id], channels: [], everyone: false },
    },
  });
  // Actor replies to my root.
  await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
    headers: { authorization: `Bearer ${actorBody.accessToken}`, origin: ORIGIN },
    data: {
      idempotencyKey: `actlu-r-${stamp}`,
      content: 'reply to you',
      parentMessageId: rootId,
    },
  });
  // Actor reacts to my root.
  await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages/${rootId}/reactions`, {
    headers: { authorization: `Bearer ${actorBody.accessToken}`, origin: ORIGIN },
    data: { emoji: '👍' },
  });

  const feed = await request.get(`${API}/me/activity?filter=all&limit=50`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
  });
  expect(feed.ok()).toBeTruthy();
  const body = (await feed.json()) as { items: Array<{ kind: string }> };
  const kinds = new Set(body.items.map((i) => i.kind));
  expect(kinds.has('mention')).toBe(true);
  expect(kinds.has('reply')).toBe(true);
  expect(kinds.has('reaction')).toBe(true);
});
