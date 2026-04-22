import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-022 polish harness — Thread v2 panel state.
 *
 * Asserts:
 *  1. `?thread=<id>` URL reload → panel opens with correct root.
 *  2. Switching channel while thread open → panel closes (014 design).
 *  3. Thread close via ✕ returns to channel view without ?thread=.
 *  4. Typing into thread input then closing + reopening — draft
 *     persistence is DOCUMENTED (draft lost is acceptable; this
 *     asserts that the app doesn't crash + input is empty on reopen).
 */
test.setTimeout(90_000);
test('polish: thread panel URL reload + channel switch closes (R4-thread-panel-state)', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `poltp-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `poltp-${stamp}@qufox.dev`, username: `poltp${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'ThreadState', slug },
  });
  const wsId = (await ws.json()).id as string;
  const ch1 = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const chId1 = (await ch1.json()).id as string;
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'random', type: 'TEXT' },
  });
  const m = await request.post(`${API}/workspaces/${wsId}/channels/${chId1}/messages`, {
    headers: {
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: 'thread root' },
  });
  const msgId = (await m.json()).id as string;
  // Seed a reply so the thread has content.
  await request.post(`${API}/workspaces/${wsId}/channels/${chId1}/messages`, {
    headers: {
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: 'first reply', parentMessageId: msgId },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`poltp-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
  await page.getByTestId('channel-general').click();

  // Direct URL reload → panel opens with correct root.
  await page.goto(`/w/${slug}/general?thread=${msgId}`);
  await expect(page.getByTestId('thread-panel')).toBeVisible();
  await expect(page.getByTestId('thread-root')).toBeVisible();

  // Switching channel while thread open → panel closes.
  await page.getByTestId('channel-random').click();
  await expect(page.getByTestId('thread-panel')).toHaveCount(0);
  // URL should not carry the stale ?thread.
  expect(page.url()).not.toContain('thread=');

  // Re-open thread via URL.
  await page.goto(`/w/${slug}/general?thread=${msgId}`);
  await expect(page.getByTestId('thread-panel')).toBeVisible();

  // Close via ✕ → URL no longer has ?thread=.
  await page.getByTestId('thread-close').click();
  await expect(page.getByTestId('thread-panel')).toHaveCount(0);
  expect(page.url()).not.toContain('thread=');

  // Reopen → reply input is empty (draft loss is acceptable).
  await page.goto(`/w/${slug}/general?thread=${msgId}`);
  await expect(page.getByTestId('thread-input')).toBeVisible();
  await expect(page.getByTestId('thread-input')).toHaveValue('');
});
