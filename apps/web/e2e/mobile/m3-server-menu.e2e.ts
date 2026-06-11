import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT_PRO,
  bootstrapWorkspace,
  inviteAndJoin,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * 071-M3 F11 — F2 서버 메뉴 시트 게이트(감사 A-48/B-81/B-82).
 *
 *  - server-header 탭 → 시트 오픈(openSheetFromPanel — 패널 닫기 후 지연
 *    오픈 레이스 봉인의 회귀 가드).
 *  - OWNER 는 관리 항목 전부 노출 + 나가기 숨김(서버도 거부), 설정 항목은
 *    /w/:slug/settings 로 라우팅(F1 분기 소비).
 *  - MEMBER 는 디렉터리/둘러보기/나가기만 노출(권한 게이트 3종 분리 검증).
 *  - 071-M6 T1 ⑤: 디렉터리 전환 시 오버레이가 열린 채 유지(600ms) — M5 리뷰
 *    H-2(시트 마커 소거가 다음 마커 표면을 pop 하는 레이스) 수리 회귀 가드.
 */
test.setTimeout(120_000);

test('server menu sheet — owner sees admin items; settings routes to /settings', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `smo-${stamp.toString(36)}`;
  const token = await signupToken(request, `smoa-${stamp}@qufox.dev`, `smoa${stamp}`);
  await bootstrapWorkspace(request, token, { name: 'SrvMenu', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `smoa-${stamp}@qufox.dev`, slug);

  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-server-menu-trigger').click();
  const sheet = page.getByTestId('mobile-server-menu-sheet');
  await expect(sheet).toBeVisible();
  // 패널은 시트 오픈 전에 닫힌다(openSheetFromPanel — 마커 레이스 가드).
  await expect(page.getByTestId('mobile-panels')).toHaveAttribute('data-open', 'center');

  for (const id of [
    'mobile-server-menu-directory',
    'mobile-server-menu-browse',
    'mobile-server-menu-invite',
    'mobile-server-menu-invites',
    'mobile-server-menu-create-channel',
    'mobile-server-menu-create-category',
    'mobile-server-menu-settings',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  // OWNER 는 나가기 숨김(서버 거부 정합).
  await expect(page.getByTestId('mobile-server-menu-leave')).toHaveCount(0);

  // 071-M6 T1 ⑤ (M5 리뷰 H-2 수리 회귀 가드): 디렉터리 항목 → 시트 마커 소거
  // (history.back)와 오버레이 마커 push 가 경합하면 방금 연 오버레이가 즉시
  // 닫혔다(transitionSheetMarker 핸드셰이크가 수리). 오버레이가 열린 뒤 600ms
  // 가 지나도 열려 있어야 한다.
  await page.getByTestId('mobile-server-menu-directory').click();
  const directory = page.getByTestId('mobile-directory-overlay');
  await expect(directory).toBeVisible();
  await page.waitForTimeout(600);
  await expect(directory).toBeVisible();
  // 닫기 버튼으로 정리 후(오버레이 back 마커 소거 popstate 정착 대기 — 곧바로
  // 시트를 재오픈하면 지연 popstate 가 새 시트 마커를 pop 하는 레이스) 메뉴를
  // 다시 열어 기존 설정 라우팅 단언을 잇는다.
  await page.getByTestId('mobile-directory-overlay-close').click();
  await expect(directory).toHaveCount(0);
  await page.waitForTimeout(250);
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-server-menu-trigger').click();
  await expect(sheet).toBeVisible();

  // 설정 항목 → F1 라우팅 분기 소비(/w/:slug/settings 직마운트, 채널로 안 튕김).
  await page.getByTestId('mobile-server-menu-settings').click();
  await page.waitForURL(new RegExp(`/w/${slug}/settings$`));
  await expect(page.getByTestId('mobile-ws-settings')).toBeVisible();
  await expect(page.getByTestId('ws-settings-tab-general')).toBeVisible();
  await page.waitForTimeout(800);
  expect(new URL(page.url()).pathname).toBe(`/w/${slug}/settings`);

  await context.close();
});

test('server menu sheet — member sees directory/browse/leave only', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `smm-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `smma-${stamp}@qufox.dev`, `smma${stamp}`);
  const bTok = await signupToken(request, `smmb-${stamp}@qufox.dev`, `smmb${stamp}`);
  const { workspaceId } = await bootstrapWorkspace(request, aTok, {
    name: 'SrvMenuM',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `smmb-${stamp}@qufox.dev`, slug);

  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-server-menu-trigger').click();
  await expect(page.getByTestId('mobile-server-menu-sheet')).toBeVisible();

  await expect(page.getByTestId('mobile-server-menu-directory')).toBeVisible();
  await expect(page.getByTestId('mobile-server-menu-browse')).toBeVisible();
  await expect(page.getByTestId('mobile-server-menu-leave')).toBeVisible();
  for (const id of [
    'mobile-server-menu-invite',
    'mobile-server-menu-invites',
    'mobile-server-menu-create-channel',
    'mobile-server-menu-create-category',
    'mobile-server-menu-settings',
  ]) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }

  await context.close();
});
