import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  API,
  ORIGIN,
  PW,
  bootstrapWorkspace,
  inviteAndJoin,
  signupToken,
} from '../mobile/_helpers';

/**
 * 072-N1 — 데스크톱 DM 셸 그룹/생성/숨기기 게이트.
 *
 * 종전 데스크톱 DmShell 은 1:1 만 렌더하고 그룹 DM·생성 모달·숨기기/나가기/뮤트
 * 기간 메뉴가 통째 dormant 였다. 이 스펙은:
 *   ① 새 메시지 모달에서 친구 2명 선택 → 그룹 생성 → /dm/g/:id 진입 + 컴포저 렌더
 *   ② 사이드바에 그룹 행(data-kind=group) 표시
 *   ③ 1:1 행 컨텍스트 메뉴 "대화 숨기기" → 목록에서 사라짐
 * 을 회귀 게이트로 고정한다. (데스크톱 verify-hook 가입 = signupToken.)
 */
test.setTimeout(120_000);

async function becomeFriends(
  request: APIRequestContext,
  aTok: string,
  bTok: string,
  bUsername: string,
): Promise<void> {
  const req = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${aTok}`, origin: ORIGIN },
    data: { username: bUsername },
  });
  expect(req.ok()).toBeTruthy();
  const pendingId = ((await req.json()) as { id: string }).id;
  const acc = await request.post(`${API}/me/friends/${pendingId}/accept`, {
    headers: { authorization: `Bearer ${bTok}`, origin: ORIGIN },
  });
  expect(acc.ok()).toBeTruthy();
}

test('desktop DM shell: group create modal + sidebar group row + hide 1:1', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `n1d-${stamp.toString(36)}`;
  const aEmail = `n1da-${stamp}@qufox.dev`;
  const bUser = `n1db${stamp}`;
  const cUser = `n1dc${stamp}`;
  const aTok = await signupToken(request, aEmail, `n1da${stamp}`);
  const bTok = await signupToken(request, `n1db-${stamp}@qufox.dev`, bUser);
  const cTok = await signupToken(request, `n1dc-${stamp}@qufox.dev`, cUser);

  // 공유 워크스페이스(전역 DM 의 implicit host) + B·C 가입.
  const { workspaceId } = await bootstrapWorkspace(request, aTok, {
    name: 'N1 Desktop',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);
  await inviteAndJoin(request, aTok, workspaceId, cTok);

  // A 가 B·C 와 친구(그룹 DM 친구 게이트 충족).
  await becomeFriends(request, aTok, bTok, bUser);
  await becomeFriends(request, aTok, cTok, cUser);

  // A 데스크톱 로그인.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/login`);
  await page.getByTestId('login-email').fill(aEmail);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ORIGIN}/dm`);
  await expect(page.getByTestId('dm-shell-root')).toBeVisible();

  // ① 새 메시지 모달 → B·C 선택 → 그룹 생성.
  await page.getByTestId('dm-new-trigger').click();
  await expect(page.getByTestId('dm-new-modal')).toBeVisible();
  await page.getByTestId(`dm-new-candidate-${bUser}`).click();
  await page.getByTestId(`dm-new-candidate-${cUser}`).click();
  // 2명 선택 → 버튼 라벨이 "그룹 만들기 (2)".
  await expect(page.getByTestId('dm-new-submit')).toContainText('그룹');
  await page.getByTestId('dm-new-submit').click();

  // 그룹 대화로 진입(/dm/g/:channelId) + 컴포저 렌더.
  await expect(page).toHaveURL(/\/dm\/g\//);
  await expect(page.getByTestId('msg-composer')).toBeVisible({ timeout: 15_000 });

  // ② 사이드바에 그룹 행(data-kind=group) 존재.
  const groupRow = page.locator('[data-testid^="dm-shell-row-"][data-kind="group"]');
  await expect(groupRow.first()).toBeVisible();

  // ②-b (적대 리뷰 HIGH 회귀고정): 그룹 대화 중 무관한 검색어를 입력해도 열린
  //     대화가 언마운트되지 않는다(그룹은 멤버 엔드포인트로 q 와 독립 해석).
  await page.getByTestId('dm-shell-search').fill('zzz-no-such-conversation');
  await page.waitForTimeout(450); // 250ms 디바운스 경과 대기
  await expect(page).toHaveURL(/\/dm\/g\//);
  await expect(page.getByTestId('msg-composer')).toBeVisible();
  await page.getByTestId('dm-shell-search').fill(''); // 복구

  // ③ 사이드바 친구(B)를 눌러 1:1 DM 개설 → 대화 목록 행 등장 → 컨텍스트 메뉴
  //    "대화 숨기기" → 목록에서 사라짐(전부 UI 주도, B userId API 불필요).
  await page.getByTestId(`dm-side-friend-${bUser}`).click();
  await expect(page.getByTestId(`dm-shell-row-${bUser}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`dm-shell-row-${bUser}`).click({ button: 'right' });
  await page.getByTestId(`dm-shell-hide-${bUser}`).click();
  await expect(page.getByTestId(`dm-shell-row-${bUser}`)).toHaveCount(0, { timeout: 15_000 });

  // ④ (적대 리뷰 MEDIUM 회귀고정): /dm/g (groupId 누락) 딥링크가 무한 로딩에
  //    빠지지 않고 빈/그룹 상태로 안전 폴백한다(userId='g' 비-UUID 400 루프 차단).
  await page.goto(`${ORIGIN}/dm/g`);
  await expect(page.getByTestId('dm-shell-root')).toBeVisible();
  await expect(page.getByTestId('dm-shell-loading')).toHaveCount(0, { timeout: 10_000 });

  await context.close();
});
