import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

test.setTimeout(60_000);

/**
 * task-035-E: mobile Home (no slug) renders the split rail: narrow
 * left column with DM button on top + workspace avatars, and wider
 * right column showing DM list by default. Tapping a workspace
 * avatar swaps the right column to that workspace's channel list
 * without navigating to /w/:slug.
 */
test('mobile Home renders rail + content split; rail selects workspace vs DM', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mhb-${stamp}@qufox.dev`;
  const username = `mhb${stamp}`;
  const slug = `mhb-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, { name: 'Mhb', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);
  await page.goto('/');

  await expect(page.getByTestId('mobile-home')).toBeVisible();
  await expect(page.getByTestId('mobile-home-rail')).toBeVisible();
  await expect(page.getByTestId('mobile-home-content')).toBeVisible();
  await expect(page.getByTestId('mobile-rail-dm')).toBeVisible();
  await expect(page.getByTestId('mobile-rail-new')).toBeVisible();
  await expect(page.getByTestId('mobile-rail-discover')).toBeVisible();

  // Default selection = DM.
  await expect(page.getByTestId('mobile-rail-dm')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('mobile-home-dm-empty')).toBeVisible();

  // Workspace rail switches content.
  const wsBtn = page.getByTestId(`mobile-rail-ws-${slug}`);
  await expect(wsBtn).toBeVisible();
  await wsBtn.click();
  await expect(wsBtn).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('mobile-rail-dm')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId(`mobile-home-channel-general`)).toBeVisible();

  await context.close();
});
