import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';

test('expired access token triggers refresh-on-401 flow', async ({ page, context }) => {
  const stamp = Date.now();
  const email = `ref-${stamp}@qufox.dev`;
  const username = `ref${stamp}`;

  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-username').fill(username);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(username);

  // Reload wipes the in-memory access token. AuthProvider's boot path calls
  // /auth/refresh (using the HttpOnly cookie) to mint a new access token and
  // restores the session — exercising the "refresh on boot" flow.
  await page.reload();
  await expect(page.getByTestId('home-username')).toHaveText(username);

  // Ensure the refresh cookie was rotated at least once.
  const cookies = await context.cookies();
  const refresh = cookies.find((c) => c.name === 'refresh_token');
  expect(refresh).toBeTruthy();
});
