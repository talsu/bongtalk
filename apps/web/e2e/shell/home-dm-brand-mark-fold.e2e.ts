import { test, expect } from '@playwright/test';

/**
 * task-039-B regression spec for hot-fix `1a2c321`. The standalone
 * DM icon that used to sit above the BrandMark home button on the
 * server rail was folded into the BrandMark itself: clicking the
 * brand mark routes to /dm. The dedicated DM icon must NOT come back
 * (no `ws-nav-dm` testid in the live tree).
 */

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(45_000);

test('brand-mark on the rail navigates to /dm and no separate DM icon exists', async ({
  browser,
  request,
}) => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 99999)}`;
  const email = `hbf-${stamp}@qufox.dev`;
  const username = `hbf${stamp}`;
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

  // Navigate away first so we can detect the click takes us back to /dm.
  await page.goto('/discover');
  await expect(page.getByTestId('discover-shell-root')).toBeVisible();

  const home = page.getByTestId('ws-nav-home');
  await expect(home).toBeVisible();
  await expect(home).toHaveAttribute('aria-label', '메세지');
  await home.click();
  await page.waitForURL(/\/dm(\/|$)/);

  // No separate DM icon button — the testid must not exist.
  await expect(page.getByTestId('ws-nav-dm')).toHaveCount(0);
  await ctx.close();
});
