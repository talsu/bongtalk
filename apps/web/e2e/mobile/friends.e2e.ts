import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';
const PW = 'Quanta-Beetle-Nebula-42!';

test.setTimeout(60_000);

test('mobile /friends renders qf-m-segment + qf-m-fab; FAB opens add sheet', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mfr-${stamp}@qufox.dev`;
  const username = `mfr${stamp}`;
  const slug = `mfr-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, { name: 'MFr', slug, channels: ['general'] });

  // Seed a second user to search for.
  const bUser = `mfrb${stamp}`;
  await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `mfr-b-${stamp}@qufox.dev`, username: bUser, password: PW },
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);
  await page.goto('/friends');

  await expect(page.getByTestId('mobile-friends')).toBeVisible();
  await expect(page.getByTestId('mobile-friends-segment')).toBeVisible();
  await expect(page.getByTestId('mobile-friends-fab')).toBeVisible();

  await page.getByTestId('mobile-friends-fab').click();
  await expect(page.getByTestId('mobile-friends-add-sheet')).toBeVisible();
  await page.getByTestId('mobile-friends-add-username').fill(bUser);
  await page.getByTestId('mobile-friends-add-submit').click();

  // Switch to outgoing tab — the just-sent request should appear.
  await page.getByTestId('mobile-friends-tab-pending_outgoing').click();
  await expect(page.getByTestId(`mobile-friend-row-${bUser}`)).toBeVisible();

  await context.close();
});
