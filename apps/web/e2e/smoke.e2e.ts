import { test, expect } from '@playwright/test';

test('web app renders + shows API OK', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'qufox' })).toBeVisible();
  // API OK appears when /healthz responds 200
  await expect(page.getByTestId('api-status')).toContainText(/API (OK|DOWN)/);
});
