import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT_PRO, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * 071-M2 E6/E7 (M1 리뷰 M-4) — 스와이프 답장 = 스레드 답글 단일 경로
 * (구 swipe-reply-direct 의 replyTarget 배너 모델 대체).
 *
 * 스와이프-오른쪽은 데드엔드였던 답장 배너 대신 전체화면 스레드 패널을 연다.
 * 패널에서 답글을 보내면 루트에 스레드가 달린다.
 */
test.setTimeout(120_000);

test('swipe-right on a message opens the thread panel (reply path)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `swt-${stamp.toString(36)}`;
  const token = await signupToken(request, `swta-${stamp}@qufox.dev`, `swta${stamp}`);
  await bootstrapWorkspace(request, token, { name: 'SwipeThread', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `swta-${stamp}@qufox.dev`, slug);

  await page.getByTestId('mobile-msg-input').fill('swipe me');
  await page.getByTestId('mobile-composer-send').click();
  const row = page
    .locator('[data-testid^="mobile-msg-"][data-mine="true"]:not([data-testid^="mobile-msg-tmp-"])')
    .first();
  await expect(row).toBeVisible();

  // 행 위에서 우측 스와이프(셀 좌표 기준 — 패널 엣지(24px) 밖에서 시작해
  // MobilePanels 의 엣지 제스처와 충돌하지 않는다).
  await row.evaluate(async (el) => {
    const mk = (x: number, y: number): Touch =>
      new Touch({ identifier: 3, target: el, clientX: x, clientY: y });
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
    const rct = el.getBoundingClientRect();
    const y = rct.top + rct.height / 2;
    fire('touchstart', 100, y);
    for (let x = 120; x <= 240; x += 20) {
      fire('touchmove', x, y);
      await new Promise((res) => setTimeout(res, 16));
    }
    fire('touchend', 240, y);
  });

  // 스레드 패널(dialog)이 열린다 — replyTarget 배너는 더 이상 존재하지 않는다.
  await expect(page.locator('[role="dialog"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="mobile-reply-banner"]')).toHaveCount(0);

  await context.close();
});
