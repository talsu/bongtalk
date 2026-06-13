import { test, expect } from '@playwright/test';
import {
  ORIGIN,
  PW,
  bootstrapWorkspace,
  apiSendMessage,
  signupToken,
} from '../mobile/_helpers';

/**
 * 072-N4 — 데스크톱 검색 게이트.
 *
 * 종전 onJump 이 closeSearchPanel() 을 호출해 결과 점프 시 패널이 닫혔고, 정렬
 * 토글이 없었다. 이 스펙은:
 *   ① 결과 카드 클릭 → ?msg= 점프 + 검색 패널 유지(N4-1)
 *   ② 정렬 탭(관련도순/최신순) 노출 + 전환(N4-2)
 * 을 회귀 게이트로 고정한다.
 */
test.setTimeout(120_000);

test('desktop search: jump keeps panel open + sort tabs', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `n4d-${stamp.toString(36)}`;
  const email = `n4d-${stamp}@qufox.dev`;
  const needle = `needle${stamp}`;
  const tok = await signupToken(request, email, `n4d${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, tok, {
    name: 'N4 Desktop',
    slug,
    channels: ['general'],
  });
  await apiSendMessage(request, tok, workspaceId, channelIds.general!, `${needle} 검색 표적 메시지`);

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/login`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ORIGIN}/w/${slug}/general`);
  await expect(page.getByTestId('bottom-bar')).toBeVisible();

  // 검색 → Enter 로 결과 패널 오픈.
  await page.keyboard.press('Control+/');
  await expect(page.getByTestId('topbar-search')).toBeFocused();
  await page.getByTestId('topbar-search').fill(needle);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('search-result-panel')).toBeVisible({ timeout: 10_000 });

  // ② 정렬 탭 노출 + 전환(N4-2).
  await expect(page.getByTestId('search-sort-relevance')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('search-sort-recent').click();
  await expect(page.getByTestId('search-sort-recent')).toHaveAttribute('aria-selected', 'true');

  // ① 결과 카드 클릭 → ?msg= 점프 + 패널 유지(N4-1).
  const card = page.locator('[data-testid^="search-card-"]').first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await expect(page).toHaveURL(/\?msg=/);
  await expect(page.getByTestId('search-result-panel')).toBeVisible();

  await context.close();
});
