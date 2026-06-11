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
 * 071-M3 F11 — F4 '모두 읽음'+Undo / F5 채널 뮤트 시트 게이트
 * (감사 B-60 / B-12·B-26, FR-RS-18·FR-CH-17 모바일).
 *
 *  - 좌패널 섹션 액션 '모두 읽음' → 미읽음 배지 소거 → Undo 토스트 → 복원.
 *  - 채널 행 롱프레스 → 뮤트 시트 → 15분 뮤트 → data-muted + 배지 억제
 *    → 다시 롱프레스 → 해제 → 배지 복귀.
 */
test.setTimeout(120_000);

test('mark all read clears badges; undo toast restores them', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `mar-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `mara-${stamp}@qufox.dev`, `mara${stamp}`);
  const bTok = await signupToken(request, `marb-${stamp}@qufox.dev`, `marb${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, aTok, {
    name: 'MarkAll',
    slug,
    channels: ['general', 'news'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);
  // B 가 news 에 전송 → A(general 랜딩)의 news 행에 미읽음 배지.
  await apiSendMessage(request, bTok, workspaceId, channelIds.news!, '미읽음 표적');

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `mara-${stamp}@qufox.dev`, slug);
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/general`));

  await page.getByTestId('mobile-topbar-menu').click();
  const newsRow = page.getByTestId('mobile-channel-news');
  await expect(newsRow.getByTestId('mobile-unread')).toBeVisible();

  // 모두 읽음 → 배지 소거 + Undo 토스트.
  await page.getByTestId('mobile-mark-all-read').click();
  await expect(newsRow.getByTestId('mobile-unread')).toHaveCount(0);
  await expect(page.getByTestId('toast-action-info')).toBeVisible();

  // Undo → 스냅샷 복원으로 배지 복귀.
  await page.getByTestId('toast-action-info').click();
  await expect(newsRow.getByTestId('mobile-unread')).toBeVisible();

  await context.close();
});

test('channel long-press opens the mute sheet; mute suppresses the badge', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `mut-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `muta-${stamp}@qufox.dev`, `muta${stamp}`);
  const bTok = await signupToken(request, `mutb-${stamp}@qufox.dev`, `mutb${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, aTok, {
    name: 'MuteCh',
    slug,
    channels: ['general', 'news'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);
  await apiSendMessage(request, bTok, workspaceId, channelIds.news!, '뮤트 배지 표적');

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `muta-${stamp}@qufox.dev`, slug);

  await page.getByTestId('mobile-topbar-menu').click();
  const newsRow = page.getByTestId('mobile-channel-news');
  await expect(newsRow.getByTestId('mobile-unread')).toBeVisible();

  // 롱프레스(500ms 타이머) → 시트. 합성 click 미발화라 내비게이션 없음.
  await dispatchLongPress(newsRow);
  const sheet = page.getByTestId('mobile-channel-sheet-news');
  await expect(sheet).toBeVisible();
  await page.getByTestId('mobile-channel-mute-15m').click();

  // 뮤트 표시: data-muted + bell-off + 미읽음 배지 억제(감사 B-12).
  await expect(newsRow).toHaveAttribute('data-muted', 'true');
  await expect(newsRow.getByTestId('mobile-unread')).toHaveCount(0);
  // 내비게이션이 일어나지 않았다(suppress 가드 — 활성 채널은 그대로 general).
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/general`));

  // 다시 롱프레스 → 해제 → 배지 복귀.
  await dispatchLongPress(newsRow);
  await expect(page.getByTestId('mobile-channel-sheet-news')).toBeVisible();
  await page.getByTestId('mobile-channel-unmute').click();
  await expect(newsRow).not.toHaveAttribute('data-muted', 'true');
  await expect(newsRow.getByTestId('mobile-unread')).toBeVisible();

  // M4 (FR-RS-09): 시트의 '읽음으로 표시' — 채널 진입 없이 배지 소거.
  await dispatchLongPress(newsRow);
  const sheet2 = page.getByTestId('mobile-channel-sheet-news');
  await expect(sheet2).toBeVisible();
  await page.getByTestId('mobile-channel-mark-read').click();
  await expect(newsRow.getByTestId('mobile-unread')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/general`));

  await context.close();
});
