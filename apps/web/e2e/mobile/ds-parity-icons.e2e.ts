import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * task-026-H: UI chrome emoji → 102-icon pack swap. This spec asserts
 * that no hardcoded UI chrome emoji leak into the rendered mobile
 * shell — not a grep over source, but an actual DOM read so dynamic
 * paths (drawer open, tabbar) are covered too.
 *
 * Reaction emoji (user content) is intentionally preserved; this
 * spec only runs on the shell subtree, not the message list.
 */
const UI_CHROME_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{FE0F}]/u;

test.setTimeout(60_000);

test('mobile shell chrome has zero hardcoded UI emoji in the visible DOM', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mico-${stamp}@qufox.dev`;
  const username = `mico${stamp}`;
  const slug = `mico-${stamp.toString(36)}`;
  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'MIco',
    slug,
    channels: ['alpha'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  // Snapshot: topbar, tabbar.
  const snaps: Array<{ label: string; text: string }> = [];
  snaps.push({
    label: 'topbar',
    text: (await page.getByTestId('mobile-shell').locator('.qf-m-topbar').innerText()) ?? '',
  });
  snaps.push({
    label: 'tabbar',
    text: (await page.getByTestId('mobile-tabbar').innerText()) ?? '',
  });
  // Open drawer → scan its text.
  await page.getByTestId('mobile-topbar-menu').click();
  snaps.push({
    label: 'left-drawer',
    text: (await page.getByTestId('mobile-left-drawer').innerText()) ?? '',
  });
  await page.keyboard.press('Escape');

  for (const s of snaps) {
    expect(s.text, `${s.label} contained a UI chrome emoji: ${s.text}`).not.toMatch(
      UI_CHROME_EMOJI,
    );
  }

  await context.close();
});
