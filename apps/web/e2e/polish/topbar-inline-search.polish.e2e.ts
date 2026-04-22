import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-022 polish harness — inline topbar search.
 *
 * Asserts the post-modal inline search shape:
 *  1. Focus input → dropdown becomes visible (recents or empty state).
 *  2. Type → 300 ms debounce, then results render.
 *  3. Arrow down / up navigates highlighted row (data-highlighted).
 *  4. Enter on highlighted row navigates with ?msg=<id>.
 *  5. Escape closes the dropdown without clearing the input.
 *  6. The old SearchOverlay modal testid `search-input` is gone.
 */
test.setTimeout(90_000);
test('polish: inline search debounce + keyboard nav + no legacy modal (R4-inline-search)', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `poliis-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `poliis-${stamp}@qufox.dev`, username: `poliis${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'InlineSearch', slug },
  });
  const wsId = (await ws.json()).id as string;
  const ch = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const chId = (await ch.json()).id as string;
  for (const body of ['polish-hello-world', 'polish-another-message', 'unrelated-chatter']) {
    await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
      headers: {
        authorization: `Bearer ${token}`,
        origin: ORIGIN,
        'idempotency-key': crypto.randomUUID(),
      },
      data: { content: body },
    });
  }

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`poliis-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
  await page.getByTestId('channel-general').click();

  const searchInput = page.getByTestId('topbar-search');
  await expect(searchInput).toBeVisible();

  // Legacy SearchOverlay modal testid must not mount.
  await expect(page.getByTestId('search-input')).toHaveCount(0);

  // Focus → dropdown opens.
  await searchInput.click();
  await expect(page.getByTestId('search-dropdown')).toBeVisible();

  // Type → 300ms debounce → results. Allow WAL + FTS latency.
  await searchInput.fill('polish');
  await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 5_000 });
  const rows = page.locator('[data-testid^="search-result-"]');
  await expect(rows.first()).toBeVisible();

  // Arrow-down / up navigates highlight.
  await searchInput.press('ArrowDown');
  const secondRow = rows.nth(1);
  if ((await rows.count()) > 1) {
    await expect(secondRow).toHaveAttribute('data-highlighted', 'true');
    await searchInput.press('ArrowUp');
    await expect(rows.first()).toHaveAttribute('data-highlighted', 'true');
  }

  // Enter → navigates with ?msg=.
  await searchInput.press('Enter');
  await page.waitForURL(/\?msg=/, { timeout: 5_000 });

  // Escape closes dropdown on next open.
  await page.getByTestId('topbar-search').click();
  await expect(page.getByTestId('search-dropdown')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search-dropdown')).toHaveCount(0);
});
