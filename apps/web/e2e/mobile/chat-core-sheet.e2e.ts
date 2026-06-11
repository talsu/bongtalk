import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT_PRO,
  apiSendMessage,
  bootstrapWorkspace,
  dispatchLongPress,
  inviteAndJoin,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * 071-M1 D11 — 메시지 시트 게이트 (D9).
 *
 *   - 타인 메시지 시트: 확장 액션(저장/리마인더/핀/미읽/신고/더보기) 노출,
 *     편집/삭제 숨김, 포커스 트랩(첫 포커서블로 이동), 신고 → ReportModal.
 *   - 내 메시지 삭제 2-step: 첫 탭 armed 카피, 두 번째 탭에 삭제.
 *   - 이모지 드로어: 더보기 → 검색 → 선택 → 리액션 칩 반영.
 */
test.setTimeout(120_000);

const theirRowSelector =
  '[data-testid^="mobile-msg-"]:not([data-mine="true"]):not([data-testid^="mobile-msg-tmp-"]):not([data-testid^="mobile-msg-sheet-"])';

test('sheet on another member message exposes extended actions and opens report modal', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `mss-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `mssa-${stamp}@qufox.dev`, `mssa${stamp}`);
  const bTok = await signupToken(request, `mssb-${stamp}@qufox.dev`, `mssb${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, aTok, {
    name: 'M1 Sheet',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);
  await apiSendMessage(request, bTok, workspaceId, channelIds.general!, '타인 메시지 — 시트 대상');

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `mssa-${stamp}@qufox.dev`, slug);
  await expect(page.getByTestId('mobile-message-list')).toContainText('타인 메시지');

  await dispatchLongPress(page.locator(theirRowSelector).first());
  const sheet = page.locator('[data-testid^="mobile-msg-sheet-"]').first();
  await expect(sheet).toBeVisible();

  // M4 (FR-MSG-10/12): 시트 헤더 전송 시각 — grouped 행 hover 시각의 모바일 동등.
  // testid 는 mobile-msg-sheet- prefix 선택자(시트 루트 매칭)와 충돌하지 않게 별도.
  await expect(page.getByTestId('mobile-sheet-time')).toBeVisible();
  await expect(page.getByTestId('mobile-sheet-time')).toHaveAttribute('title', /T.*Z$/);

  for (const id of [
    'mobile-msg-save',
    'mobile-msg-reminder',
    'mobile-msg-pin',
    'mobile-msg-mark-unread',
    'mobile-msg-report',
    'mobile-more-reactions',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  // 타인 메시지 — 편집/삭제 숨김.
  await expect(page.getByTestId('mobile-msg-edit')).toHaveCount(0);
  await expect(page.getByTestId('mobile-msg-delete')).toHaveCount(0);
  // D9 포커스 트랩: 시트가 열리면 포커스가 시트 안으로 이동한다.
  const focusInSheet = await page.evaluate(() => {
    const el = document.querySelector('[data-testid^="mobile-msg-sheet-"]');
    return el ? el.contains(document.activeElement) : false;
  });
  expect(focusInSheet).toBe(true);

  await page.getByTestId('mobile-msg-report').click();
  await expect(page.getByTestId('report-modal')).toBeVisible();

  await context.close();
});

test('deleting my message requires the in-place 2-step confirm', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `msd-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `msda-${stamp}@qufox.dev`, `msda${stamp}`);
  await bootstrapWorkspace(request, aTok, { name: 'M1 Delete', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `msda-${stamp}@qufox.dev`, slug);
  await page.getByTestId('mobile-msg-input').fill('삭제 2-step 대상');
  await page.getByTestId('mobile-composer-send').click();

  const myRow = page
    .locator('[data-testid^="mobile-msg-"][data-mine="true"]:not([data-testid^="mobile-msg-tmp-"])')
    .first();
  await expect(myRow).toBeVisible();
  await dispatchLongPress(myRow);

  const del = page.getByTestId('mobile-msg-delete');
  await del.click();
  // 1단계: armed — 시트 유지 + 확인 카피.
  await expect(del).toHaveAttribute('data-armed', 'true');
  await expect(del).toContainText('한 번 더 탭하면 삭제됩니다');
  // 2단계: 실제 삭제.
  await del.click();
  await expect(page.getByTestId('mobile-message-list')).not.toContainText('삭제 2-step 대상', {
    timeout: 10_000,
  });

  await context.close();
});

test('emoji drawer search picks an emoji and the reaction chip appears on the row', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `mse-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `msea-${stamp}@qufox.dev`, `msea${stamp}`);
  const bTok = await signupToken(request, `mseb-${stamp}@qufox.dev`, `mseb${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, aTok, {
    name: 'M1 Drawer',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);
  await apiSendMessage(request, bTok, workspaceId, channelIds.general!, '드로어 반응 대상');

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `msea-${stamp}@qufox.dev`, slug);
  await expect(page.getByTestId('mobile-message-list')).toContainText('드로어 반응 대상');

  const row = page.locator(theirRowSelector).first();
  await dispatchLongPress(row);
  await page.getByTestId('mobile-more-reactions').click();
  await expect(page.getByTestId('mobile-emoji-drawer')).toBeVisible();

  await page.getByTestId('mobile-emoji-search').fill('tada');
  await page.locator('.qf-m-emoji-drawer__cell').first().click();
  await expect(page.getByTestId('mobile-emoji-drawer')).toHaveCount(0);
  await expect(row.locator('.qf-reaction').filter({ hasText: '🎉' }).first()).toBeVisible({
    timeout: 10_000,
  });

  await context.close();
});
