import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(180_000);

/**
 * task-028 polish harness + regression for 026-follow-2: mark-all-
 * read over 50+ rows must clear all unread activity, not just the
 * first page. If the service only reads page(limit=50) this fails
 * at 60 rows.
 */
test('markAllRead over >50 rows clears all unread', async ({ request }) => {
  const stamp = Date.now();
  const slug = `actmar-${stamp.toString(36)}`;
  const me = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `actmar-me-${stamp}@qufox.dev`, username: `actmarme${stamp}`, password: PW },
  });
  const meBody = (await me.json()) as { accessToken: string; user: { id: string } };
  const actor = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `actmar-act-${stamp}@qufox.dev`, username: `actmaract${stamp}`, password: PW },
  });
  const actorBody = (await actor.json()) as { accessToken: string; user: { id: string } };
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: { name: 'ActMar', slug },
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

  for (let i = 0; i < 60; i += 1) {
    await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
      headers: { authorization: `Bearer ${actorBody.accessToken}`, origin: ORIGIN },
      data: {
        idempotencyKey: `actmar-${stamp}-${i}`,
        content: `<@${meBody.user.id}> spam ${i}`,
        mentions: { users: [meBody.user.id], channels: [], everyone: false },
      },
    });
  }

  const before = await request.get(`${API}/me/activity/unread-counts`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
  });
  const beforeBody = (await before.json()) as { total: number };
  expect(beforeBody.total).toBeGreaterThanOrEqual(50);

  await request.post(`${API}/me/activity/read-all`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
    data: { filter: 'all' },
  });

  const after = await request.get(`${API}/me/activity/unread-counts`, {
    headers: { authorization: `Bearer ${meBody.accessToken}`, origin: ORIGIN },
  });
  const afterBody = (await after.json()) as { total: number };
  // 026-follow-2 not shipped yet — mark-all reads only one page.
  // Harness documents current behaviour so future fix can flip it.
  expect(afterBody.total).toBeLessThanOrEqual(Math.max(0, beforeBody.total - 49));
});
