import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT_PRO,
  apiSendMessage,
  bootstrapWorkspace,
  loginUI,
  signupToken,
} from './_helpers';

const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * 071-M3 F11 — F3 저장함·핀 목록 게이트(감사 A-6·A-7 / FR-PS-04·FR-PS-07).
 *
 *  - 나 탭 '저장됨' 행(+카운트 배지) → /saved 풀스크린(SavedView 재사용).
 *  - topbar 핀 버튼(카운트 병기) → 핀 목록 → 항목 탭 → ?msg= 점프 + 강조.
 */
test.setTimeout(120_000);

test('you tab saved row routes to /saved with the saved message', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `sav-${stamp.toString(36)}`;
  const token = await signupToken(request, `sava-${stamp}@qufox.dev`, `sava${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, token, {
    name: 'Saved',
    slug,
    channels: ['general'],
  });
  const msgId = await apiSendMessage(
    request,
    token,
    workspaceId,
    channelIds.general!,
    '저장함 표적 메시지',
  );
  const save = await request.post(`${API}/me/saved/${msgId}`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
  });
  expect(save.ok()).toBe(true);

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `sava-${stamp}@qufox.dev`, slug);

  await page.getByTestId('mobile-tab-you').click();
  await expect(page.getByTestId('mobile-you-saved')).toBeVisible();
  await expect(page.getByTestId('mobile-you-saved-count')).toHaveText('1');

  await page.getByTestId('mobile-you-saved').click();
  await page.waitForURL(/\/saved$/);
  await expect(page.getByTestId('mobile-saved-screen')).toBeVisible();
  await expect(page.getByTestId('mobile-saved-screen')).toContainText('저장함 표적 메시지');

  // 뒤로가기 행 → 저장함을 떠난다(탭바 '나' 컨텍스트 유지).
  await page.getByTestId('mobile-saved-back').click();
  await expect(page).not.toHaveURL(/\/saved$/);

  await context.close();
});

test('topbar pin button opens the pin list; tap jumps with highlight', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `pin-${stamp.toString(36)}`;
  const token = await signupToken(request, `pina-${stamp}@qufox.dev`, `pina${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, token, {
    name: 'Pins',
    slug,
    channels: ['general'],
  });
  const msgId = await apiSendMessage(
    request,
    token,
    workspaceId,
    channelIds.general!,
    '핀 점프 표적',
  );
  const pin = await request.post(
    `${API}/workspaces/${workspaceId}/channels/${channelIds.general!}/messages/${msgId}/pin`,
    { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } },
  );
  expect(pin.ok()).toBe(true);

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `pina-${stamp}@qufox.dev`, slug);

  await expect(page.getByTestId('mobile-topbar-pin')).toBeVisible();
  await expect(page.getByTestId('mobile-pin-count')).toHaveText('1');
  await page.getByTestId('mobile-topbar-pin').click();
  await expect(page.getByTestId('mobile-pin-list')).toBeVisible();
  await expect(page.getByTestId('mobile-pin-list')).toContainText('핀 점프 표적');

  // 항목 탭 → ?msg= 점프(D6 경로 재사용) — 행 스크롤 + 2초 강조.
  await page.getByTestId(`mobile-pin-jump-${msgId}`).click();
  await expect(
    page.locator(`[data-testid="mobile-msg-${msgId}"][data-jump-highlight="true"]`),
  ).toBeVisible();

  await context.close();
});
