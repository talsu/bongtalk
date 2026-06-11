import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT_PRO,
  apiSendMessage,
  bootstrapWorkspace,
  inviteAndJoin,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * 071-M3 F11 — F1 설정 직진입 / F7 상태 화면 / M2 이월 풀체인 게이트.
 *
 *  - /w/:slug/settings 직진입이 채널로 튕기지 않는다(★F1 lastChannel 가드).
 *  - 빈 채널은 OWNER 에게 시작 CTA 를 보여준다(감사 B-20).
 *  - 스레드 탭 항목 → ?thread= → 스레드 패널 풀체인.
 *  - 검색 탭 히트 → ?msg= → 행 강조 풀체인.
 *  - 나 탭 로그아웃 → confirm 2-step → /login.
 */
test.setTimeout(120_000);

test('direct /settings entry mounts settings without channel bounce; empty channel shows CTA', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `stc-${stamp.toString(36)}`;
  const token = await signupToken(request, `stca-${stamp}@qufox.dev`, `stca${stamp}`);
  await bootstrapWorkspace(request, token, {
    name: 'States',
    slug,
    channels: ['general', 'blank'],
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `stca-${stamp}@qufox.dev`, slug);

  // F1: 설정 직진입 — lastChannel 자동복원이 라우트를 가로채지 않는다.
  await page.goto(`/w/${slug}/settings`);
  await expect(page.getByTestId('mobile-ws-settings')).toBeVisible();
  await expect(page.getByTestId('ws-settings-tab-general')).toBeVisible();
  await page.waitForTimeout(800);
  expect(new URL(page.url()).pathname).toBe(`/w/${slug}/settings`);

  // F7: 메시지 0건 채널 — OWNER 시작 CTA.
  await page.goto(`/w/${slug}/blank`);
  await expect(page.getByTestId('mobile-channel-empty')).toBeVisible();
  await expect(page.getByTestId('creator-empty-cta')).toBeVisible();

  await context.close();
});

test('threads tab item opens the thread panel via ?thread=', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `thc-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `thca-${stamp}@qufox.dev`, `thca${stamp}`);
  const bTok = await signupToken(request, `thcb-${stamp}@qufox.dev`, `thcb${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, aTok, {
    name: 'ThreadChain',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);
  const rootId = await apiSendMessage(
    request,
    aTok,
    workspaceId,
    channelIds.general!,
    '스레드 루트',
  );
  // A 도 답글로 참여(스레드 탭 목록 소스) + B 답글로 미읽음 생성.
  await apiSendMessage(request, aTok, workspaceId, channelIds.general!, '루트 작성자 답글', {
    parentMessageId: rootId,
  });
  await apiSendMessage(request, bTok, workspaceId, channelIds.general!, '상대 답글', {
    parentMessageId: rootId,
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `thca-${stamp}@qufox.dev`, slug);

  await page.getByTestId('mobile-tab-threads').click();
  await expect(page.getByTestId('mobile-threads-tab')).toBeVisible();
  const item = page.getByTestId(`mobile-thread-item-${rootId}`);
  await expect(item).toBeVisible();
  await item.click();

  // ?thread= 풀체인 — 채널 라우트로 이동 후 스레드 패널(dialog)이 열린다.
  await page.waitForURL(new RegExp(`/w/${slug}/general`));
  await expect(page.locator('[role="dialog"]').first()).toBeVisible();
  await expect(page.locator('[role="dialog"]').first()).toContainText('상대 답글');

  await context.close();
});

test('search hit jumps to the message with highlight via ?msg=', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `sch-${stamp.toString(36)}`;
  const token = await signupToken(request, `scha-${stamp}@qufox.dev`, `scha${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, token, {
    name: 'SearchChain',
    slug,
    channels: ['general'],
  });
  const msgId = await apiSendMessage(
    request,
    token,
    workspaceId,
    channelIds.general!,
    'zebrafinch 검색 표적',
  );

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `scha-${stamp}@qufox.dev`, slug);

  await page.getByTestId('mobile-tab-search').click();
  await page.getByTestId('mobile-search-input').fill('zebrafinch');
  const hit = page.getByTestId(`mobile-search-hit-${msgId}`);
  await expect(hit).toBeVisible();
  await hit.click();

  // ?msg= 풀체인 — 채널 라우트 + 행 스크롤/강조(D6 점프 경로).
  await page.waitForURL(new RegExp(`/w/${slug}/general`));
  await expect(
    page.locator(`[data-testid="mobile-msg-${msgId}"][data-jump-highlight="true"]`),
  ).toBeVisible();

  await context.close();
});

test('you tab logout requires confirm then lands on /login', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `lgo-${stamp.toString(36)}`;
  const token = await signupToken(request, `lgoa-${stamp}@qufox.dev`, `lgoa${stamp}`);
  await bootstrapWorkspace(request, token, { name: 'Logout', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `lgoa-${stamp}@qufox.dev`, slug);

  await page.getByTestId('mobile-tab-you').click();
  await page.getByTestId('mobile-you-logout').click();
  await expect(page.getByTestId('mobile-logout-confirm')).toBeVisible();
  // 취소 → 닫힘, 세션 유지.
  await page.getByTestId('mobile-logout-cancel').click();
  await expect(page.getByTestId('mobile-logout-confirm')).toHaveCount(0);
  // 재시도 → 확정 → /login.
  await page.getByTestId('mobile-you-logout').click();
  await page.getByTestId('mobile-logout-submit').click();
  await page.waitForURL(/\/login/);

  await context.close();
});
