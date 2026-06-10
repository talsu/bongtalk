import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';
const PW = 'Quanta-Beetle-Nebula-42!';

test.setTimeout(90_000);

/**
 * task-028 polish harness: mobile qf-m-fab triggers the member
 * search sheet → pick → navigates to /dms/:userId with the chat
 * mounted. Matches mobile-mockups.jsx ScreenDMs FAB flow.
 */
test('mobile FAB opens member sheet; pick routes to /dms/:userId', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `mfab-${stamp.toString(36)}`;
  const aEmail = `mfab-a-${stamp}@qufox.dev`;
  const aUser = `mfaba${stamp}`;
  const bUser = `mfabb${stamp}`;

  // 071-M0 C12 스펙 부패 일괄 수리:
  //  - b 도 verify 훅 경유(S66 게이트), 존재하지 않는 GET /me/workspaces 제거
  //    (bootstrapWorkspace 가 workspaceId 를 반환), 초대 응답은 { invite: { code } }.
  //  - 새 DM 후보는 '친구' 목록 기반(FR-DM 친구 게이트) — a↔b 친구 관계를 시드.
  //  - DMs 탭은 task-033 에서 제거됨 — /dms 직접 진입으로 교체.
  const aToken = await signupToken(request, aEmail, aUser);
  const bEmail = `mfab-b-${stamp}@qufox.dev`;
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: bEmail, username: bUser, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };
  await request.post(`${API}/auth/test-hooks/verify-email`, {
    headers: { origin: ORIGIN },
    data: { email: bEmail },
  });

  const { workspaceId } = await bootstrapWorkspace(request, aToken, {
    name: 'MFab',
    slug,
    channels: ['general'],
  });
  const inv = await request.post(`${API}/workspaces/${workspaceId}/invites`, {
    headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
    data: {},
  });
  const invCode = ((await inv.json()) as { invite: { code: string } }).invite.code;
  await request.post(`${API}/invites/${invCode}/accept`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
  });

  // a↔b 친구 관계(새 DM 후보 목록의 소스).
  await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${bBody.accessToken}`, origin: ORIGIN },
    data: { username: aUser },
  });
  const pending = await request.get(`${API}/me/friends?status=pending_incoming`, {
    headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
  });
  const pendingRow = ((await pending.json()) as { items: Array<{ friendshipId: string }> })
    .items[0];
  await request.post(`${API}/me/friends/${pendingRow.friendshipId}/accept`, {
    headers: { authorization: `Bearer ${aToken}`, origin: ORIGIN },
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const page = await context.newPage();
  await loginUI(page, aEmail, slug);

  await page.goto('/dms');
  await page.waitForURL(/\/dms$/);
  await expect(page.getByTestId('mobile-dm-fab-new')).toBeVisible();
  await page.getByTestId('mobile-dm-fab-new').click();
  await expect(page.getByTestId('mobile-dm-new-sheet')).toBeVisible();
  await page.getByTestId('mobile-dm-new-search-input').fill(bUser);
  await page.getByTestId(`mobile-dm-new-candidate-${bUser}`).click();
  await page.waitForURL(new RegExp(`/dms/${bBody.user.id}`));
  await expect(page.getByTestId('mobile-dm-chat')).toBeVisible();

  await context.close();
});
