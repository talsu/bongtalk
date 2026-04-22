import { test } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

/**
 * task-030-H regression: private workspaces still create without
 * category/description (pre-030 behaviour preserved).
 */
test('CreateWorkspacePage: PRIVATE keeps old shape — no category + no description required', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `cpr-${stamp}@qufox.dev`, username: `cpr${stamp}`, password: PW },
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(`cpr-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/(w\/new|$)/);
  await page.goto('/w/new');

  await page.getByTestId('ws-name').fill('Private Only');
  await page.getByTestId('ws-slug').fill(`priv-${stamp.toString(36)}`);
  await page.getByTestId('ws-create-submit').click();
  await page.waitForURL(/\/w\/priv-/);

  await context.close();
});
