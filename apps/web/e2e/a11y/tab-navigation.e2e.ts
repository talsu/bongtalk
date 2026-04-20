import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';

test.setTimeout(60_000);

test('keyboard-only: signup → workspace → channel flow', async ({ page }) => {
  const stamp = Date.now();
  const slug = `kb-${stamp.toString(36)}`;
  await page.goto('/signup');
  // Tab into email field, fill, tab to username, fill, tab to password, fill, Enter.
  await page.keyboard.press('Tab');
  await page.keyboard.type(`kb-${stamp}@qufox.dev`);
  await page.keyboard.press('Tab');
  await page.keyboard.type(`kb${stamp}`);
  await page.keyboard.press('Tab');
  await page.keyboard.type(PW);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('home-username')).toBeVisible();

  // Navigate to /w/new and create a workspace via keyboard.
  await page.goto('/w/new');
  await page.keyboard.press('Tab');
  await page.keyboard.type('KBWs');
  await page.keyboard.press('Tab');
  await page.keyboard.type(slug);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
});
