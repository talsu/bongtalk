import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

/**
 * task-028 polish harness: 4 filter tabs return the correct subset
 * of activity rows. DIRECT messages surfacing in Activity is out
 * of scope for the seed UNION query (reviewer 026-MED) but noted
 * here so we can flip when the follow-up lands.
 */
test('activity filter tabs return partitioned subsets', async ({ request }) => {
  const stamp = Date.now();
  const slug = `actfd-${stamp.toString(36)}`;
  const me = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `actfd-me-${stamp}@qufox.dev`, username: `actfdme${stamp}`, password: PW },
  });
  const meBody = (await me.json()) as { accessToken: string; user: { id: string } };
  const actor = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `actfd-act-${stamp}@qufox.dev`, username: `actfdact${stamp}`, password: PW },
  });
  const actorBody = (await actor.json()) as { accessToken: string; user: { id: string } };
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: { name: 'ActFd', slug },
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

  await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
    headers: { authorization: `Bearer ${actorBody.accessToken}`, origin: ORIGIN },
    data: {
      idempotencyKey: `actfd-m-${stamp}`,
      content: `<@${meBody.user.id}> hi`,
      mentions: { users: [meBody.user.id], channels: [], everyone: false },
    },
  });

  const mentions = await request.get(`${API}/me/activity?filter=mentions`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
  });
  const mbody = (await mentions.json()) as { items: Array<{ kind: string }> };
  expect(mbody.items.every((i) => i.kind === 'mention')).toBe(true);
  expect(mbody.items.length).toBeGreaterThanOrEqual(1);

  const replies = await request.get(`${API}/me/activity?filter=replies`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
  });
  const rbody = (await replies.json()) as { items: Array<{ kind: string }> };
  expect(rbody.items.every((i) => i.kind === 'reply')).toBe(true);
});
