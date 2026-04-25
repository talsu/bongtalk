import { test, expect } from '@playwright/test';

/**
 * task-039-B regression spec for hot-fix `d72b606`. A brand new
 * account with zero workspace memberships must land on `/dm` after
 * login — never `/w/new`. The server rail still shows "+" and the
 * compass icon so the user can opt in to creating a workspace or
 * browsing public ones, but the create flow is no longer a forced
 * gate.
 */

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(45_000);

test('zero-workspace user lands on /dm after login', async ({ browser, request }) => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 99999)}`;
  const email = `zwl-${stamp}@qufox.dev`;
  const username = `zwl${stamp}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username, password: PW },
  });
  if (!res.ok()) throw new Error(`signup: ${res.status()}`);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();

  // Land on /dm, NOT /w/new.
  await page.waitForURL(/\/dm(\/|$)/);
  expect(page.url()).not.toMatch(/\/w\/new/);

  // Server rail still has the create + discover buttons available
  // (workspaces sidebar is empty otherwise).
  await expect(page.getByTestId('ws-nav-new')).toBeVisible();
  await expect(page.getByTestId('ws-nav-discover')).toBeVisible();
  await expect(page.getByTestId('ws-nav-home')).toBeVisible();
  // The deprecated "ws-nav-dm" testid (the standalone DM icon
  // before the brand-mark fold) must not exist.
  await expect(page.getByTestId('ws-nav-dm')).toHaveCount(0);
  await ctx.close();
});

test('hitting / directly with zero workspace also redirects to /dm', async ({
  browser,
  request,
}) => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 99999)}`;
  const email = `zwl2-${stamp}@qufox.dev`;
  const username = `zwl2${stamp}`;
  await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username, password: PW },
  });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/dm');
  await page.goto('/');
  await page.waitForURL(/\/dm(\/|$)/);
  await ctx.close();
});
