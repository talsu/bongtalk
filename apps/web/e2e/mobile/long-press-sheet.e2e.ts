import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT,
  bootstrapWorkspace,
  dispatchLongPress,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * Task-024 Chunk F: long-press (500ms) on a qf-m-message opens the
 * bottom sheet with quick reactions + copy + delete. We simulate the
 * touch sequence via dispatchEvent since Playwright Chromium does not
 * expose a native long-press gesture.
 */
test.setTimeout(60_000);
test('long-press on my own message opens the bottom sheet with delete', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const email = `mb-sheet-${stamp}@qufox.dev`;
  const username = `mbsht${stamp}`;
  const slug = `mb-sheet-${stamp.toString(36)}`;

  const token = await signupToken(request, email, username);
  await bootstrapWorkspace(request, token, {
    name: 'Mobile Sheet',
    slug,
    channels: ['general'],
  });

  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    hasTouch: true,
  });
  const page = await context.newPage();
  await loginUI(page, email, slug);

  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-channel-general').click();
  await page.getByTestId('mobile-msg-input').fill('press me');
  await page.getByTestId('mobile-composer-send').click();
  await expect(page.getByTestId('mobile-message-list')).toContainText('press me');

  const row = page
    .getByTestId('mobile-message-list')
    // 071-M0 C12 플레이크 근원: 낙관적(tmp-) 행이 WS 확정 스왑으로 detach 되는 찰나에
    // dispatch 하면 이벤트가 루트까지 버블되지 않아 조용히 증발한다 — 확정 행만 잡는다.
    .locator('[data-testid^="mobile-msg-"][data-mine="true"]:not([data-testid^="mobile-msg-tmp-"])')
    .first();
  await expect(row).toBeVisible();

  // Simulate the touch long-press via synthetic events so the
  // setTimeout(500) in MobileMessageRow fires.
  // M5 S6: 부하 시 dispatch 증발 flake — 공용 헬퍼(미출현 시 1회 재시도)로 교체.
  const sheet = page.locator('[data-testid^="mobile-msg-sheet-"]').first();
  await dispatchLongPress(row, 650, sheet);
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('mobile-msg-copy')).toBeVisible();
  await expect(page.getByTestId('mobile-msg-delete')).toBeVisible();

  // ESC closes the sheet.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  await context.close();
});
