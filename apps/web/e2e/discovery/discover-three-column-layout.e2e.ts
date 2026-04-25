import { test, expect } from '@playwright/test';

/**
 * task-039-B regression spec for hot-fix `76ce9cc`. The /discover
 * shell must render a three-column layout (rail | aside | main)
 * matching DmShell + Shell. Mobile collapses to the screen-stack
 * variant so this test asserts only the desktop tree at viewport
 * 1280×720 — the mobile MobileDiscover surface has its own e2e
 * coverage in /e2e/mobile/.
 */

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

async function signup(request: import('@playwright/test').APIRequestContext) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 99999)}`;
  const email = `dtcl-${stamp}@qufox.dev`;
  const username = `dtcl${stamp}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username, password: PW },
  });
  const body = (await res.json()) as { accessToken: string; user: { id: string } };
  return { email, username, accessToken: body.accessToken };
}

test('desktop /discover renders [rail | aside | main]', async ({ browser, request }) => {
  const u = await signup(request);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(u.email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/dm');

  await page.goto('/discover');
  await expect(page.getByTestId('discover-shell-root')).toBeVisible();

  // Three required testids must all be present.
  const rail = page.getByTestId('workspace-nav');
  const aside = page.getByTestId('discover-side');
  const main = page.getByTestId('discover-page');
  await expect(rail).toBeVisible();
  await expect(aside).toBeVisible();
  await expect(main).toBeVisible();

  // Layout invariant — left to right ordering of bounding boxes.
  const rb = await rail.boundingBox();
  const ab = await aside.boundingBox();
  const mb = await main.boundingBox();
  expect(rb && ab && mb).toBeTruthy();
  expect(rb!.x).toBeLessThan(ab!.x);
  expect(ab!.x).toBeLessThan(mb!.x);

  // Aside contains the "워크스페이스 찾기" row marked active.
  await expect(aside.getByTestId('discover-side-workspaces')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await ctx.close();
});

test('mobile /discover collapses to a single screen stack', async ({ browser, request }) => {
  const u = await signup(request);
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(u.email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/dm');

  await page.goto('/discover');
  // MobileDiscover is the mobile variant — the desktop-side rail/aside
  // testids should NOT show up here.
  await expect(page.getByTestId('workspace-nav')).toHaveCount(0);
  await expect(page.getByTestId('discover-side')).toHaveCount(0);
  await ctx.close();
});
