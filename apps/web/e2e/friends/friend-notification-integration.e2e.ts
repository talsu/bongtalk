import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

/**
 * task-032-E integration: the FRIEND_REQUEST event type is exposed
 * through /me/notifications/preferences. (The outbox dispatch + toast
 * wiring is TODO-follow — API enum + settings UI are the vertical slice.)
 */
test('FRIEND_REQUEST preference row writable via API', async ({ request }) => {
  const stamp = Date.now();
  const a = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `frn-${stamp}@qufox.dev`, username: `frn${stamp}`, password: PW },
  });
  const body = (await a.json()) as { accessToken: string };

  const upsert = await request.put(`${API}/me/notifications/preferences`, {
    headers: { authorization: `Bearer ${body.accessToken}`, origin: ORIGIN },
    data: { eventType: 'FRIEND_REQUEST', channel: 'OFF' },
  });
  expect(upsert.ok()).toBeTruthy();
  const prefs = await request.get(`${API}/me/notifications/preferences`, {
    headers: { authorization: `Bearer ${body.accessToken}`, origin: ORIGIN },
  });
  const pbody = (await prefs.json()) as {
    preferences: Array<{ eventType: string; channel: string }>;
  };
  expect(
    pbody.preferences.some((p) => p.eventType === 'FRIEND_REQUEST' && p.channel === 'OFF'),
  ).toBe(true);
});
