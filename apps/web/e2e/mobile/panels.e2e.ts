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
 * 071-M2 E7 — OverlappingPanels 3패널 게이트(구 drawer-channels/members-drawer/
 * drawer-back-button 스펙의 패널 모델 재작성 + E2 프로브 회귀 고정).
 *
 *  - 좌 패널: 메뉴 버튼 → 채널 목록 + server-header, 채널 픽 → 라우팅 + 닫힘.
 *  - 우 패널: 멤버 버튼 → 멤버 목록.
 *  - 스크림 탭 닫기, 좌 엣지 스와이프 오픈, 하드웨어 back 은 패널만 닫는다.
 */
test.setTimeout(120_000);

test('left panel lists channels with server header; pick navigates and closes', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `pnl-${stamp.toString(36)}`;
  const token = await signupToken(request, `pnla-${stamp}@qufox.dev`, `pnla${stamp}`);
  await bootstrapWorkspace(request, token, { name: 'Panels', slug, channels: ['design'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `pnla-${stamp}@qufox.dev`, slug);

  const panels = page.getByTestId('mobile-panels');
  await page.getByTestId('mobile-topbar-menu').click();
  await expect(panels).toHaveAttribute('data-open', 'left');
  await expect(page.getByTestId('mobile-server-header')).toBeVisible();
  await expect(page.getByTestId('mobile-rail-dms')).toBeVisible();

  await page.getByTestId('mobile-channel-design').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/design`));
  await expect(panels).toHaveAttribute('data-open', 'center');

  await context.close();
});

test('right panel shows the member list with presence rows', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `pnr-${stamp.toString(36)}`;
  const bUsername = `pnrb${stamp}`;
  const aTok = await signupToken(request, `pnra-${stamp}@qufox.dev`, `pnra${stamp}`);
  const bTok = await signupToken(request, `pnrb-${stamp}@qufox.dev`, bUsername);
  const { workspaceId } = await bootstrapWorkspace(request, aTok, {
    name: 'PanelsR',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `pnra-${stamp}@qufox.dev`, slug);

  // E5(FR-IA-MOB-02): 멤버 버튼은 멤버 수를 병기한다.
  await expect(page.getByTestId('mobile-member-count')).toHaveText('2');
  await page.getByTestId('mobile-topbar-members').click();
  await expect(page.getByTestId('mobile-panels')).toHaveAttribute('data-open', 'right');
  await expect(page.getByTestId(`mobile-member-${bUsername}`)).toBeVisible();

  await context.close();
});

test('scrim tap, edge swipe, and hardware back drive the panel state', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `pns-${stamp.toString(36)}`;
  const token = await signupToken(request, `pnsa-${stamp}@qufox.dev`, `pnsa${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, token, {
    name: 'PanelsS',
    slug,
    channels: ['general'],
  });
  await apiSendMessage(request, token, workspaceId, channelIds.general!, '패널 제스처 대상');

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `pnsa-${stamp}@qufox.dev`, slug);
  const panels = page.getByTestId('mobile-panels');

  // 좌 엣지 스와이프 오픈(E2 프로브 포팅 — touch 합성 드래그).
  await panels.evaluate(async (el) => {
    const mk = (x: number, y: number): Touch =>
      new Touch({ identifier: 7, target: el, clientX: x, clientY: y });
    const fire = (type: string, x: number, y: number): void => {
      el.dispatchEvent(
        new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [mk(x, y)],
          targetTouches: type === 'touchend' ? [] : [mk(x, y)],
          changedTouches: [mk(x, y)],
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    fire('touchstart', 8, 400);
    for (let x = 20; x <= 180; x += 20) {
      fire('touchmove', x, 400);
      await new Promise((res) => setTimeout(res, 16));
    }
    fire('touchend', 180, 400);
  });
  await expect(panels).toHaveAttribute('data-open', 'left');

  // 하드웨어 back → 패널만 닫히고 URL 유지(E2 ★함정의 회귀 가드).
  const urlBefore = page.url();
  await page.goBack();
  await expect(panels).toHaveAttribute('data-open', 'center');
  expect(page.url()).toBe(urlBefore);

  // 우 패널 → 스크림 탭 닫기(show-right 시 가시 영역은 스크림 좌표계 우측).
  await page.getByTestId('mobile-topbar-members').click();
  await expect(panels).toHaveAttribute('data-open', 'right');
  await page.getByTestId('mobile-panel-scrim').click({ position: { x: 300, y: 400 }, force: true });
  await expect(panels).toHaveAttribute('data-open', 'center');

  await context.close();
});
