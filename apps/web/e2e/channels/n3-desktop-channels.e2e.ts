import { test, expect } from '@playwright/test';
import { ORIGIN, PW, bootstrapWorkspace, signupToken } from '../mobile/_helpers';

/**
 * 072-N3 — 데스크톱 채널 생성 모달 + 아카이브 게이트.
 *
 * 종전 CreateChannelModal 은 type=TEXT 하드코딩·비공개 토글 없음·'설명'이 topic 에
 * 바인딩이었고, 채널 아카이브 UI 가 없었다. 이 스펙은:
 *   ① 생성 모달에서 공지 타입 + 비공개 토글 + 설명 입력 → 채널 생성 → 사이드바에
 *      비공개(lock) prefix 로 표시
 *   ② 채널 설정의 보관(아카이브) 토글 → '보관 해제'로 전환
 * 을 회귀 게이트로 고정한다.
 */
test.setTimeout(120_000);

test('desktop channels: create modal (type/private/description) + archive toggle', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `n3d-${stamp.toString(36)}`;
  const email = `n3d-${stamp}@qufox.dev`;
  const chName = `n3ch${stamp}`;
  const tok = await signupToken(request, email, `n3d${stamp}`);
  await bootstrapWorkspace(request, tok, { name: 'N3 Desktop', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/login`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ORIGIN}/w/${slug}/general`);
  await expect(page.getByTestId('bottom-bar')).toBeVisible();

  // ① 생성 모달: 공지 타입 + 비공개 + 설명.
  await page.getByTestId('channel-default-add').click();
  await expect(page.getByTestId('create-channel-form')).toBeVisible();
  await page.getByTestId('create-channel-type-announcement').click();
  await expect(page.getByTestId('create-channel-type-announcement')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByTestId('create-channel-private').click();
  await expect(page.getByTestId('create-channel-private')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('create-channel-name').fill(chName);
  await page.getByTestId('create-channel-topic').fill('N3 토픽');
  await page.getByTestId('create-channel-description').fill('N3 둘러보기 설명');
  await page.getByTestId('create-channel-submit').click();

  // 사이드바에 새 채널 행 등장 + 비공개라 lock prefix(아이콘 존재).
  const row = page.getByTestId(`channel-${chName}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.locator('.qf-channel__prefix svg')).toBeVisible();

  // ② 채널 설정 → 보관 토글 → '보관 해제'로 전환.
  await page.goto(`${ORIGIN}/w/${slug}/${chName}/settings`);
  const archiveBtn = page.getByTestId('channel-settings-archive-toggle');
  await expect(archiveBtn).toBeVisible({ timeout: 15_000 });
  await expect(archiveBtn).toBeEnabled();
  await expect(archiveBtn).toHaveText('채널 보관');
  await archiveBtn.click();
  await expect(archiveBtn).toHaveText('보관 해제', { timeout: 15_000 });

  await context.close();
});
