import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('CreateWorkspacePage: PUBLIC toggle reveals category + description', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `cp-${stamp}@qufox.dev`, username: `cp${stamp}`, password: PW },
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(`cp-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/(w\/new|$)/);
  await page.goto('/w/new');

  // PRIVATE by default — category + description fields hidden.
  await expect(page.getByTestId('ws-category-field')).toHaveCount(0);
  await expect(page.getByTestId('ws-description-field')).toHaveCount(0);
  await expect(page.getByTestId('ws-visibility-public')).not.toBeChecked();

  // Toggle PUBLIC — fields appear.
  await page.getByTestId('ws-visibility-public').check();
  await expect(page.getByTestId('ws-category-field')).toBeVisible();
  await expect(page.getByTestId('ws-description-field')).toBeVisible();

  // Fill + submit.
  await page.getByTestId('ws-name').fill('Public Playground');
  await page.getByTestId('ws-slug').fill(`pub-${stamp.toString(36)}`);
  await page.getByTestId('ws-category').selectOption('PROGRAMMING');
  await page.getByTestId('ws-description').fill('Open Korean dev chat');
  await page.getByTestId('ws-create-submit').click();
  await page.waitForURL(/\/w\/pub-/);

  await context.close();
});
