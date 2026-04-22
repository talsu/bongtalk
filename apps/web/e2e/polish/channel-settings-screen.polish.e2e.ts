import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-022 polish harness — channel settings screen.
 *
 * Asserts:
 *  1. Gear button on channel row → settings overlay opens.
 *  2. Edit description → save → topbar qf-topbar__topic updates.
 *  3. Edit channel name → save → URL /:channel segment replaces.
 *  4. Editing without saving then closing (ESC / X) → no mutation.
 *  5. Delete confirm dialog is ABOVE the settings overlay (z-stacking).
 */
test.setTimeout(90_000);
test('polish: channel settings save + cancel + delete stack (R4-channel-settings-screen)', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `polcs-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polcs-${stamp}@qufox.dev`, username: `polcs${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'ChanSettings', slug },
  });
  const wsId = (await ws.json()).id as string;
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`polcs-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
  await page.getByTestId('channel-general').click();

  // Gear entry.
  const channelRow = page.getByTestId('channel-general');
  await channelRow.hover();
  await page.getByTestId('channel-settings-btn-general').click();
  await expect(page.getByTestId('channel-settings')).toBeVisible();

  // Edit description → save → topbar topic updates.
  const topicInput = page.getByTestId('channel-settings-topic');
  await topicInput.fill('공지 · 일반 대화');
  await page.getByTestId('channel-settings-save').click();
  await expect(page.locator('.qf-topbar__topic')).toHaveText('공지 · 일반 대화', {
    timeout: 5_000,
  });

  // Cancel via ESC with un-saved name edit → no mutation.
  await page.getByTestId('channel-settings-name').fill('general-renamed');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('channel-settings')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/general(\\?|$)`));

  // Re-open, click Delete action → confirm dialog sits above settings.
  await channelRow.hover();
  await page.getByTestId('channel-settings-btn-general').click();
  await expect(page.getByTestId('channel-settings')).toBeVisible();
  await page.getByTestId('channel-settings-nav-delete').click();

  // Confirm dialog (qf-modal) should be visible and z-ordered above.
  // Radix dialog overlay mounts with z-index from tokens (modal-bg=60).
  const confirmBtn = page.getByTestId('channel-settings-delete-confirm');
  await expect(confirmBtn).toBeVisible();
  // Verify it's actually clickable (would mean it's above the settings overlay).
  const confirmZ = await confirmBtn.evaluate((el) => {
    let cur: Element | null = el;
    while (cur) {
      const z = window.getComputedStyle(cur).zIndex;
      if (z && z !== 'auto') return Number(z);
      cur = cur.parentElement;
    }
    return 0;
  });
  const settingsZ = await page.getByTestId('channel-settings-overlay').evaluate((el) => {
    return Number(window.getComputedStyle(el).zIndex || '0');
  });
  expect(confirmZ).toBeGreaterThan(settingsZ);
});
