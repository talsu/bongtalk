import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-022 polish harness — Composer v2 autogrow.
 *
 * Asserts:
 *  1. Single-line initial height (22px content minimum).
 *  2. Paste of a 10-line block grows composer height to fit (up to cap).
 *  3. Typing past the 200px cap → composer stops growing, scrolls.
 *  4. Clearing the draft → composer shrinks back to single-line.
 *  5. Shift+Enter inserts a newline without IME half-send regression.
 */
test.setTimeout(60_000);
test('polish: composer textarea grows with content + caps + shrinks (R4-composer-autogrow)', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `polag-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polag-${stamp}@qufox.dev`, username: `polag${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'AutoGrow', slug },
  });
  const wsId = (await ws.json()).id as string;
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`polag-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
  await page.getByTestId('channel-general').click();

  const input = page.getByTestId('msg-input');
  await expect(input).toBeVisible();

  // Single-line baseline (≤ ~40px including padding).
  const initialHeight = await input.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  expect(initialHeight).toBeLessThanOrEqual(40);

  // Paste 10-line block → composer grows.
  await input.focus();
  await input.fill(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
  await page.waitForTimeout(100);
  const multilineHeight = await input.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  expect(multilineHeight).toBeGreaterThan(initialHeight * 2);

  // Past the cap (200px per MessageComposer MAX_HEIGHT_PX) → height
  // stops growing. Fill with 50 lines — should cap.
  await input.fill(Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
  await page.waitForTimeout(100);
  const cappedHeight = await input.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  expect(cappedHeight).toBeLessThanOrEqual(210);
  expect(cappedHeight).toBeGreaterThanOrEqual(150);

  // Clear → shrinks back to single-line.
  await input.fill('');
  await page.waitForTimeout(100);
  const shrunkHeight = await input.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  expect(shrunkHeight).toBeLessThanOrEqual(40);

  // Shift+Enter inserts newline (no submit, no IME half-send).
  await input.fill('first');
  await input.press('Shift+Enter');
  await page.keyboard.type('second');
  const val = await input.inputValue();
  expect(val).toBe('first\nsecond');
});
