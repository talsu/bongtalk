import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT_PRO,
  bootstrapWorkspace,
  inviteAndJoin,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * 071-M1 D11 — 컴포저 게이트 (D8).
 *
 *   - @멘션 자동완성: 팝업 → 탭 삽입 → 전송 → AST 멘션 pill 렌더(D1 의 renderAst
 *     실검증 — 자동완성으로 만든 진짜 멘션 토큰을 서버 normalizeMentions 가 AST 화).
 *   - 4,000자 카운터: 경고 구간 노출 + 초과 시 전송 차단.
 *   - 첨부 업로드: 파일 선택 → presign→PUT→complete 트레이 → 전송 → 행에 이미지.
 */
test.setTimeout(120_000);

test('@mention autocomplete inserts token and renders mention pill after send', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `mcc-${stamp.toString(36)}`;
  const bUsername = `mccb${stamp}`;
  const aTok = await signupToken(request, `mcca-${stamp}@qufox.dev`, `mcca${stamp}`);
  const bTok = await signupToken(request, `mccb-${stamp}@qufox.dev`, bUsername);
  const { workspaceId } = await bootstrapWorkspace(request, aTok, {
    name: 'M1 Composer',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `mcca-${stamp}@qufox.dev`, slug);

  const input = page.getByTestId('mobile-msg-input');
  await input.click();
  await input.pressSequentially(`@${bUsername.slice(0, 8)}`, { delay: 40 });
  const popup = page.getByTestId('autocomplete-mention');
  await expect(popup).toBeVisible();
  // 터치 탭은 mousedown 으로 처리된다(Autocomplete 가 blur 전 선택을 위해 mousedown 사용).
  await popup
    .locator(`[role="option"]`)
    .filter({ hasText: bUsername })
    .first()
    .dispatchEvent('mousedown');
  await expect(input).toHaveValue(`@${bUsername} `);

  await input.pressSequentially('확인 부탁드립니다', { delay: 10 });
  await page.getByTestId('mobile-composer-send').click();
  // 확정 행(낙관 스왑 이후)에서 AST 멘션 pill 이 렌더된다.
  const confirmedRow = page
    .locator('[data-testid^="mobile-msg-"][data-mine="true"]:not([data-testid^="mobile-msg-tmp-"])')
    .last();
  await expect(confirmedRow.locator('.qf-mention').first()).toBeVisible({ timeout: 10_000 });

  await context.close();
});

test('4000-char counter shows in warning band and blocks send when over limit', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `mck-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `mcka-${stamp}@qufox.dev`, `mcka${stamp}`);
  await bootstrapWorkspace(request, aTok, { name: 'M1 Counter', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `mcka-${stamp}@qufox.dev`, slug);

  const input = page.getByTestId('mobile-msg-input');
  await input.fill('a'.repeat(3950));
  await expect(page.getByTestId('mobile-composer-counter')).toBeVisible();
  await expect(page.getByTestId('mobile-composer-send')).toBeEnabled();

  await input.fill('a'.repeat(4001));
  await expect(page.getByTestId('mobile-composer-send')).toBeDisabled();

  await context.close();
});

test('attachment upload via + button renders image in the message row', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `mca-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `mcaa-${stamp}@qufox.dev`, `mcaa${stamp}`);
  await bootstrapWorkspace(request, aTok, { name: 'M1 Attach', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `mcaa-${stamp}@qufox.dev`, slug);

  // 1×1 PNG(67 bytes).
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.getByTestId('mobile-composer-file-input').setInputFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.getByTestId('attachment-tray')).toBeVisible();
  // presign→PUT(MinIO)→상태 READY 까지 잠시 대기 — 전송 버튼 활성화로 판정
  // (업로드 중에는 uploadingCount>0 으로 비활성).
  await page.getByTestId('mobile-msg-input').fill('사진 첨부');
  await expect(page.getByTestId('mobile-composer-send')).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId('mobile-composer-send').click();

  const confirmedRow = page
    .locator('[data-testid^="mobile-msg-"][data-mine="true"]:not([data-testid^="mobile-msg-tmp-"])')
    .last();
  await expect(confirmedRow).toContainText('사진 첨부', { timeout: 10_000 });
  await expect(confirmedRow.locator('img').first()).toBeVisible({ timeout: 15_000 });

  await context.close();
});
