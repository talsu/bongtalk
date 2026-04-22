import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * Task-024 Chunk D: qf-m-composer input → send → message lands in
 * the scrolling list with the author name and body we typed.
 */
test.setTimeout(60_000);
test('mobile composer: type + send surfaces a qf-m-message row', async ({ browser, request }) => {
  const stamp = Date.now();
  const email = `mb-send-${stamp}@qufox.dev`;
  const username = `mbsnd${stamp}`;
  const slug = `mb-send-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'Mobile Send',
    slug,
    channels: ['general'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-channel-general').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/general`));

  const input = page.getByTestId('mobile-msg-input');
  await input.fill('hello from a phone');
  await page.getByTestId('mobile-composer-send').click();

  // Composer clears and message shows up in the list.
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('mobile-message-list')).toContainText('hello from a phone');

  await context.close();
});
