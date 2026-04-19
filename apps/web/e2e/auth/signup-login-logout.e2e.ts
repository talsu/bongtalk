import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';

test('signup → home → reload keeps session → logout → redirect', async ({ page }) => {
  const stamp = Date.now();
  const email = `e2e-${stamp}@qufox.dev`;
  const username = `e2e${stamp}`;

  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-username').fill(username);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();

  await expect(page.getByTestId('home-username')).toHaveText(username);
  await expect(page.getByTestId('api-status')).toContainText(/API (OK|DOWN)/);

  // Reload — AuthProvider should call /auth/refresh and restore the session.
  await page.reload();
  await expect(page.getByTestId('home-username')).toHaveText(username);

  // Log out — should clear and bounce to /login.
  await page.getByTestId('logout-btn').click();
  await expect(page).toHaveURL(/\/login$/);

  // Going back to / should redirect to login (not render home).
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});
