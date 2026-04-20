import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

/**
 * Task 010-C: CommandPalette combobox a11y. The input now carries
 * role=combobox, aria-controls → listbox, aria-expanded, and
 * aria-activedescendant pointing at the currently-focused option.
 * We verify the ARIA wiring, keyboard navigation, and axe reports
 * zero serious violations on the open palette.
 */
test('command palette: combobox aria wiring is correct', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `cpa11y-${stamp.toString(36)}`;
  const ownerRes = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: {
      email: `cpa11y-${stamp}@qufox.dev`,
      username: `cpa11y${stamp}`,
      password: PW,
    },
  });
  const token = (await ownerRes.json()).accessToken as string;
  await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'CP A11y', slug },
  });

  await page.goto('/login');
  await page.fill('[data-testid=login-email]', `cpa11y-${stamp}@qufox.dev`);
  await page.fill('[data-testid=login-password]', PW);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL('**/w/**');

  // Open palette via Ctrl+K (the shortcut set up in task-008).
  await page.keyboard.press('Control+KeyK');
  const input = page.getByTestId('palette-input');
  await expect(input).toBeVisible();

  // Core ARIA attributes.
  await expect(input).toHaveAttribute('role', 'combobox');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(input).toHaveAttribute('aria-autocomplete', 'list');
  await expect(input).toHaveAttribute('aria-controls', 'command-palette-listbox');

  // activedescendant must point at the focused option — the first one initially.
  await expect(input).toHaveAttribute('aria-activedescendant', 'command-palette-option-0');

  // Arrow-down moves the pointer; aria-activedescendant follows.
  await page.keyboard.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', /command-palette-option-1/);

  // Axe scan on the open palette.
  const results = await new AxeBuilder({ page })
    .include('[role=combobox], [role=listbox]')
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(serious, JSON.stringify(serious, null, 2)).toHaveLength(0);
});
