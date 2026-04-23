import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';
const PW = 'Quanta-Beetle-Nebula-42!';

test.setTimeout(90_000);

test.skip('mobile DM chat — create + send + appears in composer', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `mdmc-${stamp.toString(36)}`;
  const aEmail = `mdmc-a-${stamp}@qufox.dev`;
  const aUser = `mdmca${stamp}`;
  const bEmail = `mdmc-b-${stamp}@qufox.dev`;
  const bUser = `mdmcb${stamp}`;

  const aToken = await signupToken(request, aEmail, aUser);
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: bEmail, username: bUser, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };

  await bootstrapWorkspace(request, aToken, { name: 'MDmC', slug, channels: ['general'] });
  const wsId = (
    await (
      await request.get(`${API}/me/workspaces`, {
        headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
      })
    ).json()
  ).workspaces.find((w: { slug: string; id: string }) => w.slug === slug).id;
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
  await page.getByTestId('mobile-dm-fab-new').click();
  await page.getByTestId('mobile-dm-new-search-input').fill(bUser);
  await page.getByTestId(`mobile-dm-new-candidate-${bUser}`).click();
  await page.waitForURL(new RegExp(`/dms/${bBody.user.id}`));

  await expect(page.getByTestId('mobile-dm-chat')).toBeVisible();
  await page.getByTestId('mobile-msg-input').fill('mobile dm hi');
  await page.getByTestId('mobile-composer-send').click();
  await expect(page.getByTestId('mobile-message-list')).toContainText('mobile dm hi');

  await context.close();
});
