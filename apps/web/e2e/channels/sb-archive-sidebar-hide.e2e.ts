import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORIGIN, PW, bootstrapWorkspace, signupToken } from '../mobile/_helpers';

/**
 * 백로그 S-B (FR-CH-04): 보관(아카이브) 채널은 사이드바에서 숨겨지되, 설정 페이지
 * (보관 해제)는 URL 로 계속 접근 가능해야 한다. FE-only 필터(useChannelList 데이터는
 * archived 유지 → activeChannel 해석/언아카이브 보존).
 */
test.setTimeout(120_000);

async function createChannel(
  request: APIRequestContext,
  tok: string,
  wsId: string,
  name: string,
): Promise<void> {
  const r = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${tok}`, origin: ORIGIN },
    data: { name, type: 'TEXT' },
  });
  expect(r.ok()).toBeTruthy();
}

test('archived channel hidden from sidebar but settings/unarchive reachable', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `sb-${stamp.toString(36)}`;
  const email = `sb-${stamp}@qufox.dev`;
  const chName = `sbch${stamp}`;
  const tok = await signupToken(request, email, `sb${stamp}`);
  const { workspaceId } = await bootstrapWorkspace(request, tok, {
    name: 'S-B',
    slug,
    channels: ['general'],
  });
  await createChannel(request, tok, workspaceId, chName);

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/login`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ORIGIN}/w/${slug}/general`);
  // 채널이 사이드바에 보인다.
  await expect(page.getByTestId(`channel-${chName}`)).toBeVisible({ timeout: 15_000 });

  // 설정 페이지에서 보관(아카이브).
  await page.goto(`${ORIGIN}/w/${slug}/${chName}/settings`);
  const archiveBtn = page.getByTestId('channel-settings-archive-toggle');
  await expect(archiveBtn).toBeVisible({ timeout: 15_000 });
  await archiveBtn.click();
  await expect(archiveBtn).toHaveText('보관 해제', { timeout: 15_000 });

  // 사이드바로 돌아가면 보관 채널이 숨겨진다(S-B).
  await page.goto(`${ORIGIN}/w/${slug}/general`);
  await expect(page.getByTestId('channel-general')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`channel-${chName}`)).toHaveCount(0);

  // 그러나 설정 페이지는 URL 로 접근 가능 — 보관 해제 버튼 노출(언아카이브 보존).
  await page.goto(`${ORIGIN}/w/${slug}/${chName}/settings`);
  await expect(page.getByTestId('channel-settings-archive-toggle')).toHaveText('보관 해제', {
    timeout: 15_000,
  });

  await context.close();
});
