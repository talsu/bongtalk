import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT_PRO, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';
const PW = 'Quanta-Beetle-Nebula-42!';

test.setTimeout(120_000);

/**
 * 071-M3 F11 (M2 이월) — 구 DM 탭 모델 스펙을 레일 DM 슬롯 경로로 포팅.
 *
 * 진입: 좌 패널 레일의 DM 슬롯(mobile-rail-dms) → /dms → FAB 새 DM(친구
 * 후보) → /dms/:userId → 전송 → 목록 반영. 새 DM 후보는 친구 목록 기반
 * (FR-DM 친구 게이트)이라 a↔b 친구 관계를 시드한다(dm-fab-flow 와 동일).
 */
test('mobile DM chat — rail entry + create + send appears in list', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `mdmc-${stamp.toString(36)}`;
  const aEmail = `mdmc-a-${stamp}@qufox.dev`;
  const aUser = `mdmca${stamp}`;
  const bEmail = `mdmc-b-${stamp}@qufox.dev`;
  const bUser = `mdmcb${stamp}`;

  const aToken = await signupToken(request, aEmail, aUser);
  const b = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: bEmail, username: bUser, password: PW },
  });
  const bBody = (await b.json()) as { accessToken: string; user: { id: string } };
  await request.post(`${API}/auth/test-hooks/verify-email`, {
    headers: { origin: ORIGIN },
    data: { email: bEmail },
  });

  await bootstrapWorkspace(request, aToken, { name: 'MDmC', slug, channels: ['general'] });

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

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, aEmail, slug);

  // 레일 DM 슬롯 → /dms (워크스페이스-외 채팅 컨텍스트).
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-rail-dms').click();
  await page.waitForURL(/\/dms$/);

  await page.getByTestId('mobile-dm-fab-new').click();
  await expect(page.getByTestId('mobile-dm-new-sheet')).toBeVisible();
  await page.getByTestId('mobile-dm-new-search-input').fill(bUser);
  await page.getByTestId(`mobile-dm-new-candidate-${bUser}`).click();
  await page.waitForURL(new RegExp(`/dms/${bBody.user.id}`));

  await expect(page.getByTestId('mobile-dm-chat')).toBeVisible();
  await page.getByTestId('mobile-msg-input').fill('mobile dm hi');
  await page.getByTestId('mobile-composer-send').click();
  await expect(page.getByTestId('mobile-message-list')).toContainText('mobile dm hi');

  await context.close();
});
