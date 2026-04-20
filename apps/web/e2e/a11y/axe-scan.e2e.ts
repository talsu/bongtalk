import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('axe: login page has zero violations', async ({ page }) => {
  await page.goto('/login');
  const results = await new AxeBuilder({ page })
    .disableRules(['region']) // single-form page, no landmarks by design
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toHaveLength(0);
});

test('axe: signup page has zero violations', async ({ page }) => {
  await page.goto('/signup');
  const results = await new AxeBuilder({ page }).disableRules(['region']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toHaveLength(0);
});

test('axe: shell (empty workspace) has zero violations', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `a11y-${stamp.toString(36)}`;
  const ownerRes = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: {
      email: `a11y-${stamp}@qufox.dev`,
      username: `a11y${stamp}`,
      password: PW,
    },
  });
  const token = (await ownerRes.json()).accessToken as string;
  await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'Axe', slug },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`a11y-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));

  const results = await new AxeBuilder({ page }).analyze();
  // Filter out known framework false-positives that don't represent real
  // barriers (Radix adds aria-hidden on portals during animation).
  const real = results.violations.filter((v) => v.id !== 'aria-hidden-focus');
  expect(real, JSON.stringify(real, null, 2)).toHaveLength(0);
});
