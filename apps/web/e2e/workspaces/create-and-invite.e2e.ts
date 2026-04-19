import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';

test.setTimeout(60_000);
test('user A creates workspace + invites; user B accepts and appears in members', async ({ page, context, browser }) => {
  const stamp = Date.now();
  const slug = `acme-${stamp.toString(36)}`;

  // --- User A: signup → create workspace → generate invite ---
  const emailA = `a-${stamp}@qufox.dev`;
  const usernameA = `a${stamp}`;
  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(emailA);
  await page.getByTestId('signup-username').fill(usernameA);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(usernameA);

  await page.goto('/w/new');
  await page.getByTestId('ws-name').fill('Acme');
  await page.getByTestId('ws-slug').fill(slug);
  await page.getByTestId('ws-create-submit').click();

  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));
  await expect(page.getByTestId('ws-my-role')).toHaveText('OWNER');

  // Grant clipboard read/write so the "copy to clipboard" path doesn't blow up.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('ws-invite').click();
  await expect(page.getByTestId('ws-invite-url')).toBeVisible();
  const url = (await page.getByTestId('ws-invite-url').textContent()) ?? '';
  const match = url.match(/\/invite\/([A-Za-z0-9_-]+)/);
  const code = match?.[1];
  expect(code).toBeTruthy();

  // --- User B: fresh browser context → signup → accept invite ---
  const bCtx = await browser.newContext();
  const bPage = await bCtx.newPage();
  const baseURL = page.url().replace(/\/w\/.*$/, '');
  const emailB = `b-${stamp}@qufox.dev`;
  const usernameB = `b${stamp}`;

  await bPage.goto(`${baseURL}/signup`);
  await bPage.getByTestId('signup-email').fill(emailB);
  await bPage.getByTestId('signup-username').fill(usernameB);
  await bPage.getByTestId('signup-password').fill(PW);
  await bPage.getByTestId('signup-submit').click();
  await expect(bPage.getByTestId('home-username')).toHaveText(usernameB);

  await bPage.goto(`${baseURL}/invite/${code}`);
  await expect(bPage.getByTestId('invite-workspace-name')).toContainText('Acme');
  await bPage.getByTestId('invite-accept').click();
  await expect(bPage).toHaveURL(new RegExp(`/w/${slug}$`));
  await expect(bPage.getByTestId('ws-my-role')).toHaveText('MEMBER');

  // --- Back to User A: reload and see User B in members list ---
  await page.reload();
  await expect(page.getByTestId(`member-${usernameB}`)).toBeVisible();
  await expect(page.getByTestId(`role-${usernameB}`)).toHaveText('MEMBER');

  await bCtx.close();
});
