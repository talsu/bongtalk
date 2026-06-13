import { test, expect } from '@playwright/test';
import { ORIGIN, PW, bootstrapWorkspace, signupToken } from '../mobile/_helpers';

/**
 * 072-N2 — 데스크톱 프레즌스·커스텀 상태 게이트.
 *
 * 종전 BottomBar 는 영문 라벨 + Invisible 'disabled(곧 제공)' + 커스텀 상태 편집
 * 진입점 전무였다. 이 스펙은:
 *   ① presence 드롭다운 '오프라인으로 표시'(INVISIBLE 활성) → data-presence=offline
 *   ② '커스텀 상태 설정' → 모달 → 텍스트 저장 → BottomBar home-status 에 반영
 * 을 회귀 게이트로 고정한다.
 */
test.setTimeout(120_000);

test('desktop BottomBar: invisible toggle + custom status editor', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `n2d-${stamp.toString(36)}`;
  const email = `n2d-${stamp}@qufox.dev`;
  const tok = await signupToken(request, email, `n2d${stamp}`);
  await bootstrapWorkspace(request, tok, { name: 'N2 Desktop', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/login`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ORIGIN}/w/${slug}/general`);
  await expect(page.getByTestId('bottom-bar')).toBeVisible();

  // ① INVISIBLE 활성: 드롭다운 → '오프라인으로 표시' → trigger data-presence=offline.
  await page.getByTestId('presence-status-trigger').click();
  await page.getByTestId('presence-set-invisible').click();
  await expect(page.getByTestId('presence-status-trigger')).toHaveAttribute(
    'data-presence',
    'offline',
    { timeout: 5000 },
  );

  // ② 커스텀 상태 편집: 드롭다운 → '커스텀 상태 설정' → 모달 → 텍스트 저장.
  await page.getByTestId('presence-status-trigger').click();
  await page.getByTestId('bottom-bar-custom-status').click();
  await expect(page.getByTestId('custom-status-modal')).toBeVisible();
  await page.getByTestId('custom-status-text').fill('집중 모드');
  await page.getByTestId('custom-status-save').click();
  await expect(page.getByTestId('custom-status-modal')).toHaveCount(0, { timeout: 10_000 });

  // BottomBar home-status 에 커스텀 상태 텍스트 반영.
  await expect(page.getByTestId('home-status')).toContainText('집중 모드', { timeout: 10_000 });

  await context.close();
});
