import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT_PRO,
  apiSendMessage,
  bootstrapWorkspace,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * 071-M2 E7 — PRD §02 5탭 게이트(구 tabbar-3-tabs 대체 + E3/E4 프로브 회귀 고정).
 *
 *  - 탭바는 정확히 5탭: 채팅·인박스·스레드·검색·나.
 *  - 각 탭이 전용 화면으로 라우팅하고, '채팅'은 마지막 채팅 위치로 복귀한다.
 *  - 로그인 랜딩 '/' 는 홈 화면 없이 채팅 컨텍스트로 자동 진입한다(E4).
 */
test.setTimeout(120_000);

test('tabbar exposes exactly 5 tabs and routes each to its surface', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `ftb-${stamp.toString(36)}`;
  const token = await signupToken(request, `ftba-${stamp}@qufox.dev`, `ftba${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, token, {
    name: 'FiveTabs',
    slug,
    channels: ['general'],
  });
  await apiSendMessage(request, token, workspaceId, channelIds.general!, '오탭 검증 표적');

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `ftba-${stamp}@qufox.dev`, slug);

  // 정확히 5탭.
  const tabs = page.getByTestId('mobile-tabbar').locator('.qf-m-tab');
  await expect(tabs).toHaveCount(5);
  for (const id of [
    'mobile-tab-chat',
    'mobile-tab-inbox',
    'mobile-tab-threads',
    'mobile-tab-search',
    'mobile-tab-you',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.getByTestId('mobile-tab-chat')).toHaveAttribute('aria-current', 'page');

  // 인박스 → /activity.
  await page.getByTestId('mobile-tab-inbox').click();
  await expect(page).toHaveURL(/\/activity/);
  await expect(page.getByTestId('mobile-tab-inbox')).toHaveAttribute('aria-current', 'page');

  // 스레드 탭 → 전용 화면.
  await page.getByTestId('mobile-tab-threads').click();
  await expect(page.getByTestId('mobile-threads-tab')).toBeVisible();

  // 검색 탭 → 입력 노출.
  await page.getByTestId('mobile-tab-search').click();
  await expect(page.getByTestId('mobile-search-input')).toBeVisible();

  // 나 탭 → you-header + 상태/설정/로그아웃 행.
  await page.getByTestId('mobile-tab-you').click();
  await expect(page.getByTestId('mobile-you-tab')).toBeVisible();
  await expect(page.getByTestId('mobile-you-status')).toBeVisible();
  await expect(page.getByTestId('mobile-you-logout')).toBeVisible();

  // M2 리뷰 H-1 게이트: 상태 시트에서 '오프라인 표시' 선택 → 라벨이 실제로
  // 전환된다(종전엔 PATCH 도 라벨 변경도 없는 무음 no-op — invisible 매핑 검증).
  await page.getByTestId('mobile-you-status').click();
  await expect(page.getByTestId('mobile-status-sheet')).toBeVisible();
  await page.getByTestId('mobile-status-offline').click();
  await expect(page.getByTestId('mobile-you-state')).toHaveText('오프라인 표시');
  // dnd 로도 전환 — 헤더 변형 클래스까지 반영.
  await page.getByTestId('mobile-you-status').click();
  await page.getByTestId('mobile-status-dnd').click();
  await expect(page.getByTestId('mobile-you-state')).toHaveText('방해 금지');

  // 채팅 탭 → 마지막 채팅 위치 복귀.
  await page.getByTestId('mobile-tab-chat').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/general`));

  await context.close();
});

test('login landing skips the home screen and enters the chat context', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `ftl-${stamp.toString(36)}`;
  const token = await signupToken(request, `ftla-${stamp}@qufox.dev`, `ftla${stamp}`);
  await bootstrapWorkspace(request, token, { name: 'Landing', slug, channels: ['general'] });
  void token;

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByTestId('login-email').fill(`ftla-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill('Quanta-Beetle-Nebula-42!');
  await page.getByTestId('login-submit').click();
  // E4: '/' 는 채팅 컨텍스트로 자동 진입(워크스페이스 채널 라우트).
  await page.waitForURL(new RegExp(`/w/${slug}/[^/?]+`), { timeout: 15_000 });
  await expect(page.getByTestId('mobile-shell')).toBeVisible();

  // 좌 패널 레일의 DM 슬롯 → /dms (DM 인박스 = 채팅 탭의 워크스페이스-외 컨텍스트).
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-rail-dms').click();
  await expect(page).toHaveURL(/\/dms$/);

  await context.close();
});
