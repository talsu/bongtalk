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

// Reviewer R1 HIGH coverage: ThreadPanel's reply composer got the
// identical Enter-during-composition guard; this case exercises it so
// a future refactor can't silently reintroduce the bug.
test('polish: Enter during IME composition on thread reply does NOT send (R1-ime-enter-thread)', async ({
  page,
  request,
}) => {
  const stamp = Date.now() + 42;
  const slug = `polit-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polit-${stamp}@qufox.dev`, username: `polit${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'IMEThread', slug },
  });
  const wsId = (await ws.json()).id as string;
  const ch = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const chId = (await ch.json()).id as string;
  const m = await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
    headers: {
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: 'thread root' },
  });
  const msgId = (await m.json()).id as string;

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`polit-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
  await page.getByTestId('channel-general').click();

  await page.goto(`/w/${slug}/general?thread=${msgId}`);
  await expect(page.getByTestId('thread-input')).toBeVisible();

  let postsToReply = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/messages(\?|$)/.test(req.url())) {
      postsToReply += 1;
    }
  });

  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-testid="thread-input"]');
    if (!el) throw new Error('thread-input not found');
    el.focus();
    el.dispatchEvent(new CompositionEvent('compositionstart'));
    el.value = '하';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  expect(postsToReply).toBe(0);

  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-testid="thread-input"]');
    if (!el) return;
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '하' }));
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  expect(postsToReply).toBeGreaterThanOrEqual(1);
});

// Reviewer R2 discovery: MessageItem's inline edit input had the same
// Enter-during-composition bug — editing a message + pressing Enter
// mid-composition saved a half-formed syllable. Regression harness
// mirrors the composer / thread tests.
test('polish: Enter during IME composition on message edit does NOT save (R2-ime-edit-half-saves)', async ({
  page,
  request,
}) => {
  const stamp = Date.now() + 108;
  const slug = `polie-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polie-${stamp}@qufox.dev`, username: `polie${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'IMEEdit', slug },
  });
  const wsId = (await ws.json()).id as string;
  const ch = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const chId = (await ch.json()).id as string;
  const m = await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
    headers: {
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: 'editable' },
  });
  const msgId = (await m.json()).id as string;

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`polie-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
  await page.getByTestId('channel-general').click();

  const row = page.getByTestId(`msg-${msgId}`);
  await expect(row).toBeVisible();
  await row.hover();
  await page.getByTestId(`msg-edit-btn-${msgId}`).click();
  const editInput = page.getByTestId(`msg-edit-${msgId}`);
  await expect(editInput).toBeVisible();

  let patchCalls = 0;
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && /\/messages\/[^/]+(\?|$)/.test(req.url())) {
      patchCalls += 1;
    }
  });

  await page.evaluate((id) => {
    const el = document.querySelector<HTMLInputElement>(`[data-testid="msg-edit-${id}"]`);
    if (!el) throw new Error('edit input not found');
    el.focus();
    el.dispatchEvent(new CompositionEvent('compositionstart'));
    el.value = 'editable하';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, msgId);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  expect(patchCalls).toBe(0);

  await page.evaluate((id) => {
    const el = document.querySelector<HTMLInputElement>(`[data-testid="msg-edit-${id}"]`);
    if (!el) return;
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '하' }));
  }, msgId);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  expect(patchCalls).toBeGreaterThanOrEqual(1);
});

// Reviewer R2 second discovery: Ctrl+K command palette input — same
// Enter-during-composition bug. Committing a Korean search term used
// to fire the first filtered action. The negative half (Enter mid-
// composition) is the regression we guard; the positive half is
// asserted immediately after by ending composition + pressing Enter
// on a concrete channel match and checking the URL transitions.
test('polish: Enter during IME composition in Ctrl+K palette does NOT run (R2-ime-palette-half-runs)', async ({
  page,
  request,
}) => {
  const stamp = Date.now() + 216;
  const slug = `polip-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polip-${stamp}@qufox.dev`, username: `polip${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'IMEPal', slug },
  });
  const wsId = (await ws.json()).id as string;
  for (const name of ['general', 'random']) {
    await request.post(`${API}/workspaces/${wsId}/channels`, {
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      data: { name, type: 'TEXT' },
    });
  }

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`polip-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));
  await page.getByTestId('channel-general').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/general`));

  // Open palette.
  await page.locator('body').click();
  await page.keyboard.press('Control+k');
  const input = page.getByTestId('palette-input');
  await expect(input).toBeVisible();

  // Dispatch a composition; Enter mid-composition must not dismiss
  // the palette or navigate.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]');
    if (!el) throw new Error('palette-input not found');
    el.focus();
    el.dispatchEvent(new CompositionEvent('compositionstart'));
    el.value = '하';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const beforeUrl = page.url();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  expect(page.url()).toBe(beforeUrl);
  await expect(input).toBeVisible();

  // Positive half: end composition, replace query with a deterministic
  // channel name match, then Enter navigates. This matches the dual
  // assertion shape used by the composer / thread / edit IME specs.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]');
    if (!el) throw new Error('palette-input not found');
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '하' }));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, 'random');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/random`));
});
