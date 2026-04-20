import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-021 polish harness — Korean IME composition.
 *
 * Scenario: while an IME composition is in-flight (compositionstart
 * fired, compositionend NOT yet), pressing Enter must NOT send the
 * message. Compositionend followed by Enter sends exactly one clean
 * message.
 *
 * Playwright limitation: we can't drive a real Hangul IME, so we
 * synthesise the composition lifecycle via DOM events + call the
 * textarea's value setter. The assertion surface is the network —
 * either a /messages POST fires (bug) or it doesn't (fix).
 */
test.setTimeout(60_000);
test('polish: Enter during IME composition does NOT send (R1-ime-enter-half-sends)', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `poli-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `poli-${stamp}@qufox.dev`, username: `poli${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'IME', slug },
  });
  const wsId = (await ws.json()).id as string;
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`poli-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
  await page.getByTestId('channel-general').click();

  const input = page.getByTestId('msg-input');
  await input.click();

  // Track POSTs to the messages endpoint.
  let messagesPosted = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/messages(\?|$)/.test(req.url())) {
      messagesPosted += 1;
    }
  });

  // Phase 1: composition in progress. Enter must NOT send.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-testid="msg-input"]');
    if (!el) throw new Error('msg-input not found');
    el.focus();
    el.dispatchEvent(new CompositionEvent('compositionstart'));
    // Simulate typing ㅎ + ㅏ — not yet committed.
    el.value = '하';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: '하' }));
  });
  // Press Enter WITHOUT dispatching compositionend first.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  expect(messagesPosted).toBe(0);

  // Phase 2: end composition, then Enter — one clean send.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-testid="msg-input"]');
    if (!el) return;
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '하' }));
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  expect(messagesPosted).toBeGreaterThanOrEqual(1);
});
