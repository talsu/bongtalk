import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT_PRO, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * 071-M2 E6/E7 (FR-SC 모바일) — 슬래시 커맨드 모바일 게이트.
 *
 *  - `/` 자동완성 후보가 뜬다(M1 D8e 보류 해제).
 *  - `/shrug` 서버 실행 → IN_CHANNEL 게시(텍스트 변환).
 *  - `/darkmode` 클라 실행 → 테마 토글 + EPHEMERAL 확인 행.
 */
test.setTimeout(120_000);

test('slash autocomplete, server /shrug, and client /darkmode work on mobile', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `slm-${stamp.toString(36)}`;
  const token = await signupToken(request, `slma-${stamp}@qufox.dev`, `slma${stamp}`);
  await bootstrapWorkspace(request, token, { name: 'SlashM', slug, channels: ['general'] });
  void token;

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `slma-${stamp}@qufox.dev`, slug);
  const input = page.getByTestId('mobile-msg-input');

  // ① 슬래시 자동완성.
  await input.click();
  await input.pressSequentially('/shr', { delay: 40 });
  await expect(page.getByTestId('autocomplete-slash')).toBeVisible();
  await input.fill('');

  // ② /shrug → IN_CHANNEL 게시(서버가 텍스트 변환 — 렌더는 마크다운 이스케이프로
  //    백슬래시/언더스코어가 정리되므로 고정 부분 문자열 '(ツ)' 로 단언한다).
  await input.fill('/shrug 어쩔 수 없죠');
  await page.getByTestId('mobile-composer-send').click();
  await expect(page.getByTestId('mobile-message-list')).toContainText('(ツ)', {
    timeout: 10_000,
  });

  // ③ /darkmode → 테마 토글 + EPHEMERAL 확인 행(발신자 전용).
  const themeBefore = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  await input.fill('/darkmode');
  await page.getByTestId('mobile-composer-send').click();
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.getAttribute('data-theme')), {
      timeout: 5_000,
    })
    .not.toBe(themeBefore);

  await context.close();
});
