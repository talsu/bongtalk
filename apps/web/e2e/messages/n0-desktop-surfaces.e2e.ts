import { test, expect } from '@playwright/test';
import {
  API,
  ORIGIN,
  PW,
  bootstrapWorkspace,
  inviteAndJoin,
  apiSendMessage,
  signupToken,
} from '../mobile/_helpers';

/**
 * 072-N0 — 데스크톱 메시지 행·반응 표면 게이트.
 *
 * ★데스크톱 e2e 하니스 갭(N6 대상): 기존 데스크톱 스펙은 UI 가입만 해서 S66
 * 이메일 인증 게이트(E2E_TEST_HOOKS=1 스택)에 막혀 workspace 생성부터 실패한다.
 * 모바일 _helpers 의 signupToken(=가입+verify 훅) 패턴을 데스크톱에 재사용해
 * N0 표면을 직접 검증한다. N6 가 이 패턴을 데스크톱 스펙 전반에 일반화한다.
 *
 * 검증: ① hover 툴바 퀵 반응 3종(N0-1) ② 반응 칩 hover 툴팁=반응자 미리보기
 * (N0-2, previewUsers) ③ 이모지 피커 검색창(N0-4).
 */
test.setTimeout(120_000);

test('desktop message row: quick-react toolbar + reaction tooltip + emoji search', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `n0d-${stamp.toString(36)}`;
  const aEmail = `n0da-${stamp}@qufox.dev`;
  const bUser = `n0db${stamp}`;
  const aTok = await signupToken(request, aEmail, `n0da${stamp}`);
  const bTok = await signupToken(request, `n0db-${stamp}@qufox.dev`, bUser);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, aTok, {
    name: 'N0 Desktop',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);
  const msgId = await apiSendMessage(
    request,
    aTok,
    workspaceId,
    channelIds.general!,
    'N0 표적 메시지',
  );
  // B 가 👍 반응 → previewUsers 에 B 가 실린다(메시지 id 전역 유일).
  const rx = await request.post(`${API}/messages/${msgId}/reactions`, {
    headers: { authorization: `Bearer ${bTok}`, origin: ORIGIN },
    data: { emoji: '👍' },
  });
  expect(rx.ok()).toBe(true);

  // 데스크톱 뷰포트(기본 Desktop Chrome)로 A 로그인. 데스크톱 셸은 /w/:slug 에서
  // 채널 자동진입을 하지 않으므로(URL 유지 + '채널을 선택하세요') 채널로 직접 이동한다.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/login`);
  await page.getByTestId('login-email').fill(aEmail);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ORIGIN}/w/${slug}/general`);
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/general`));

  const row = page.getByTestId(`msg-${msgId}`);
  await expect(row).toBeVisible();

  // ② 반응 칩 hover → 반응자 미리보기 툴팁(previewUsers — B 표시).
  const chip = page.getByTestId('reaction-👍');
  await expect(chip).toBeVisible();
  await chip.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible({ timeout: 5000 });
  await expect(tooltip).toContainText(bUser);

  // ① 메시지 행 hover → 퀵 반응 3종 인라인 버튼(N0-1).
  await row.hover();
  await expect(page.getByTestId(`msg-quickreact-👍-${msgId}`)).toBeVisible();

  // ③ 이모지 피커 검색창(N0-4) — 피커 열기 버튼 → 검색 input.
  await page.getByTestId(`msg-react-btn-${msgId}`).click();
  await expect(page.getByTestId('emoji-picker-search')).toBeVisible();

  await context.close();
});
