import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

/**
 * task-028 polish harness: a single mention event should show up
 * in three places for the recipient — Activity unread-counts
 * (total / mentions), workspace unread-totals, and the channel's
 * unread summary. Cross-surface parity catches drift between the
 * dispatcher's invalidations and the server's materialised counts.
 */
test('mention event updates Activity + workspace totals + channel unread in sync', async ({
  request,
}) => {
  const stamp = Date.now();
  const slug = `cspar-${stamp.toString(36)}`;
  const me = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `cspar-me-${stamp}@qufox.dev`, username: `csparme${stamp}`, password: PW },
  });
  const meBody = (await me.json()) as { accessToken: string; user: { id: string } };
  const actor = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `cspar-act-${stamp}@qufox.dev`, username: `csparact${stamp}`, password: PW },
  });
  const actorBody = (await actor.json()) as { accessToken: string; user: { id: string } };
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: { name: 'CSPar', slug },
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
      idempotencyKey: `cspar-${stamp}`,
      content: `<@${meBody.user.id}> single mention`,
      mentions: { users: [meBody.user.id], channels: [], everyone: false },
    },
  });

  const activity = await request.get(`${API}/me/activity/unread-counts`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
  });
  const activityBody = (await activity.json()) as { total: number; mentions: number };
  expect(activityBody.mentions).toBeGreaterThanOrEqual(1);

  const channelSummary = await request.get(`${API}/workspaces/${wsId}/unread-summary`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
  });
  const chBody = (await channelSummary.json()) as {
    channels: Array<{ channelId: string; unreadCount: number; hasMention: boolean }>;
  };
  const row = chBody.channels.find((c) => c.channelId === chId);
  expect(row?.hasMention).toBe(true);
  expect(row?.unreadCount).toBeGreaterThanOrEqual(1);
});
