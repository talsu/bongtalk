import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';
const PW = 'Quanta-Beetle-Nebula-42!';

test.setTimeout(90_000);

/**
 * task-028 polish harness: mobile qf-m-fab triggers the member
 * search sheet → pick → navigates to /dms/:userId with the chat
 * mounted. Matches mobile-mockups.jsx ScreenDMs FAB flow.
 */
test('mobile FAB opens member sheet; pick routes to /dms/:userId', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `mfab-${stamp.toString(36)}`;
  const aEmail = `mfab-a-${stamp}@qufox.dev`;
  const aUser = `mfaba${stamp}`;
  const bUser = `mfabb${stamp}`;

  const aToken = await signupToken(request, aEmail, aUser);
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `mfab-b-${stamp}@qufox.dev`, username: bUser, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  await bootstrapWorkspace(request, aToken, { name: 'MFab', slug, channels: ['general'] });
  const wsListRes = await request.get(`${API}/me/workspaces`, {
    headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
  });
  const wsList = (await wsListRes.json()) as { workspaces: Array<{ slug: string; id: string }> };
  const wsId = wsList.workspaces.find((w) => w.slug === slug)!.id;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
    data: {},
  });
  const invCode = ((await inv.json()) as { code: string }).code;
  await request.post(`${API}/invites/${invCode}/accept`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, aEmail, slug);

  await page.getByTestId('mobile-tab-dms').click();
  await page.waitForURL(/\/dms$/);
  await expect(page.getByTestId('mobile-dm-fab-new')).toBeVisible();
  await page.getByTestId('mobile-dm-fab-new').click();
  await expect(page.getByTestId('mobile-dm-new-sheet')).toBeVisible();
  await page.getByTestId('mobile-dm-new-search-input').fill(bUser);
  await page.getByTestId(`mobile-dm-new-candidate-${bUser}`).click();
  await page.waitForURL(new RegExp(`/dms/${bBody.user.id}`));
  await expect(page.getByTestId('mobile-dm-chat')).toBeVisible();

  await context.close();
});
