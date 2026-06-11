import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import {
  API,
  MOBILE_VIEWPORT_PRO,
  ORIGIN,
  apiSendMessage,
  bootstrapWorkspace,
  inviteAndJoin,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * 071-M6 T1 — M5 신규 표면 e2e 갭 커버(m5-polish).
 *
 *  ① 친구 삭제/차단 confirm(M5 H5) — MobileConfirmSheet cancel/back/submit
 *     3 경로. submit 은 등장 300ms 입력 가드(M5 리뷰 M-11) 뒤에만 확정된다.
 *  ② 더블탭 quick-react(M5 H20) — 300ms 내 합성 tap×2 → qf-m-react-toast
 *     + 행에 👍 리액션 칩.
 *  ③ /activity 당겨서 새로고침(M5 H21) — scrollTop 0 합성 당김(임계 60px 초과)
 *     → .qf-m-ptr 스피너 출현·refetch 정착 후 소멸.
 *  ④ 시트 등장 모션(M5 H7)/grab 드래그 닫기(M5 H8) — 모션 재생 자체는
 *     reduced-motion 전역 가드 때문에 e2e 부적합이라 시트 루트의 qfa-sheet-in
 *     클래스 존재만 단언하고, 드래그 닫기는 grab 합성 드래그(dy 80 ≥ 임계 60)
 *     로 닫힘 커밋을 단언한다.
 *  (⑤ 서버 메뉴→디렉터리 전환 H-2 회귀 가드는 m3-server-menu.e2e.ts 에 추가.)
 */
test.setTimeout(120_000);

/** ① 시드용 — requester→accepter 친구 요청 후 수락(ACCEPTED 관계 확립). */
async function seedAcceptedFriendship(
  request: APIRequestContext,
  requesterToken: string,
  requesterUsername: string,
  accepterToken: string,
  accepterUsername: string,
): Promise<void> {
  const rq = await request.post(`${API}/me/friends/requests`, {
    headers: { authorization: `Bearer ${requesterToken}`, origin: ORIGIN },
    data: { username: accepterUsername },
  });
  if (!rq.ok()) throw new Error(`friend request failed: ${rq.status()} ${await rq.text()}`);
  const list = await request.get(`${API}/me/friends?status=pending_incoming`, {
    headers: { authorization: `Bearer ${accepterToken}`, origin: ORIGIN },
  });
  const items = (
    (await list.json()) as { items: Array<{ friendshipId: string; otherUsername: string }> }
  ).items;
  const row = items.find((it) => it.otherUsername === requesterUsername);
  if (!row) throw new Error(`pending incoming row not found for ${requesterUsername}`);
  const acc = await request.post(`${API}/me/friends/${row.friendshipId}/accept`, {
    headers: { authorization: `Bearer ${accepterToken}`, origin: ORIGIN },
    data: {},
  });
  if (!acc.ok()) throw new Error(`friend accept failed: ${acc.status()} ${await acc.text()}`);
}

// 071-M1 D11 패턴: 확정(non-tmp) 타인 행 선택자 — 낙관 행 스왑 레이스 회피.
const theirRowSelector =
  '[data-testid^="mobile-msg-"]:not([data-mine="true"]):not([data-testid^="mobile-msg-tmp-"]):not([data-testid^="mobile-msg-sheet-"])';

test('① friends remove/block — confirm sheet cancel/back/submit paths', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `m6p-${stamp.toString(36)}`;
  const aUser = `m6pa${stamp}`;
  const bUser = `m6pb${stamp}`;
  const cUser = `m6pc${stamp}`;
  const aTok = await signupToken(request, `m6pa-${stamp}@qufox.dev`, aUser);
  const bTok = await signupToken(request, `m6pb-${stamp}@qufox.dev`, bUser);
  const cTok = await signupToken(request, `m6pc-${stamp}@qufox.dev`, cUser);
  await bootstrapWorkspace(request, aTok, { name: 'M6 Polish', slug, channels: ['general'] });
  // A↔B, A↔C 친구 관계 시드(삭제 대상 B, 차단 대상 C).
  await seedAcceptedFriendship(request, aTok, aUser, bTok, bUser);
  await seedAcceptedFriendship(request, aTok, aUser, cTok, cUser);

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `m6pa-${stamp}@qufox.dev`, slug);
  await page.goto('/friends');
  const bRow = page.getByTestId(`mobile-friend-row-${bUser}`);
  await expect(bRow).toBeVisible();

  // 삭제 버튼 → confirm 시트(alertdialog) 오픈. ④의 일부: 등장 모션 클래스
  // (qfa-sheet-in)가 시트 패널에 붙어 있는지도 여기서 단언(모션 재생은 비대상).
  await page.getByTestId(`mobile-friend-remove-${bUser}`).click();
  const removeConfirm = page.getByTestId('mobile-friend-remove-confirm');
  await expect(removeConfirm).toBeVisible();
  await expect(removeConfirm).toHaveAttribute('role', 'alertdialog');
  await expect(removeConfirm.locator('.qf-m-sheet')).toHaveClass(/qfa-sheet-in/);

  // cancel 경로 — confirm 만 닫히고 행은 유지(뮤테이션 미발화).
  await page.getByTestId('mobile-friend-remove-confirm-cancel').click();
  await expect(removeConfirm).toHaveCount(0);
  await expect(bRow).toBeVisible();
  // 마커 소거(history.back — 비동기 트래버설) 정착 대기: 곧바로 재오픈하면
  // 새 confirm 의 qfSheet 마커가 지연 popstate 에 pop 되는 레이스(M5 S6 계열).
  await page.waitForTimeout(250);

  // back 마커 경로 — goBack 은 confirm 만 닫고 URL(/friends)은 유지된다.
  await page.getByTestId(`mobile-friend-remove-${bUser}`).click();
  await expect(removeConfirm).toBeVisible();
  await page.goBack();
  await expect(removeConfirm).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/friends');
  await expect(page.getByTestId('mobile-friends')).toBeVisible();
  await expect(bRow).toBeVisible();
  await page.waitForTimeout(250);

  // submit 경로 — 등장 300ms 입력 가드(M5 리뷰 M-11) 때문에 350ms 대기 후 클릭.
  await page.getByTestId(`mobile-friend-remove-${bUser}`).click();
  await expect(removeConfirm).toBeVisible();
  await page.waitForTimeout(350);
  await page.getByTestId('mobile-friend-remove-confirm-submit').click();
  await expect(removeConfirm).toHaveCount(0);
  await expect(bRow).toHaveCount(0);
  await page.waitForTimeout(250);

  // 차단 confirm — submit 후 전체 탭에서 사라지고 차단 탭으로 이동한다.
  const cRow = page.getByTestId(`mobile-friend-row-${cUser}`);
  await expect(cRow).toBeVisible();
  await page.getByTestId(`mobile-friend-block-${cUser}`).click();
  const blockConfirm = page.getByTestId('mobile-friend-block-confirm');
  await expect(blockConfirm).toBeVisible();
  await page.waitForTimeout(350);
  await page.getByTestId('mobile-friend-block-confirm-submit').click();
  await expect(blockConfirm).toHaveCount(0);
  await expect(cRow).toHaveCount(0);
  await page.getByTestId('mobile-friends-tab-blocked').click();
  await expect(cRow).toBeVisible();
  await expect(cRow).toHaveAttribute('data-status', 'BLOCKED');

  await context.close();
});

test('② double-tap quick-react — toast appears and 👍 chip lands on the row', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `m6q-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `m6qa-${stamp}@qufox.dev`, `m6qa${stamp}`);
  const bTok = await signupToken(request, `m6qb-${stamp}@qufox.dev`, `m6qb${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, aTok, {
    name: 'M6 QuickReact',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);
  await apiSendMessage(request, bTok, workspaceId, channelIds.general!, '더블탭 quick-react 대상');

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `m6qa-${stamp}@qufox.dev`, slug);
  await expect(page.getByTestId('mobile-message-list')).toContainText('더블탭 quick-react 대상');

  const row = page.locator(theirRowSelector).first();
  await expect(row).toBeVisible();

  // 합성 더블탭 — touchstart+touchend ×2 를 80ms 간격(판정 윈도우 300ms 내)으로
  // 행 중앙에 디스패치한다(_helpers.dispatchLongPress 의 TouchEvent 합성 패턴).
  // 행 중앙 x 는 패널 엣지(PANEL_EDGE_PX=24) 밖이라 엣지 양보에 걸리지 않는다.
  const doubleTap = (): Promise<void> =>
    row.evaluate(async (el) => {
      const target = el as HTMLElement;
      const fire = (type: string): void => {
        const rect = target.getBoundingClientRect();
        const touch = new Touch({
          identifier: 5,
          target,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        });
        target.dispatchEvent(
          new TouchEvent(type, {
            touches: type === 'touchend' ? [] : [touch],
            targetTouches: type === 'touchend' ? [] : [touch],
            changedTouches: [touch],
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      fire('touchstart');
      fire('touchend');
      await new Promise((res) => setTimeout(res, 80));
      fire('touchstart');
      fire('touchend');
    });

  await doubleTap();
  const toast = page.getByTestId('mobile-react-toast');
  // 부하 시 리렌더가 dispatch 직후 리스너를 detach 하면 탭이 증발할 수 있다
  // (dispatchLongPress ensureVisible 재시도와 동형) — 미출현 시 1회 재시도.
  // 재시도는 이미 👍 byMe 면 no-op(추가 전용 가드)이라 토글-오프 위험이 없다.
  try {
    await toast.waitFor({ state: 'visible', timeout: 1500 });
  } catch {
    await doubleTap();
  }
  await expect(toast).toBeVisible();
  await expect(toast.locator('.qf-m-react-toast__emoji')).toHaveText('👍');
  // 행에 👍 리액션 칩(ReactionBar 재사용 — reaction-<emoji> testid) 반영.
  await expect(row.getByTestId('reaction-👍')).toBeVisible();
  // 토스트는 1.2s(REACT_TOAST_MS) 후 자동 소멸.
  await expect(toast).toBeHidden({ timeout: 5_000 });

  await context.close();
});

test('③ pull-to-refresh on /activity — qf-m-ptr spinner appears then settles', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `m6r-${stamp.toString(36)}`;
  const email = `m6ra-${stamp}@qufox.dev`;
  const token = await signupToken(request, email, `m6ra${stamp}`);
  await bootstrapWorkspace(request, token, { name: 'M6 PTR', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, email, slug);
  await page.goto('/activity');
  await expect(page.getByTestId('mobile-activity')).toBeVisible();
  const body = page.getByTestId('mobile-activity-body');
  await expect(body).toBeVisible();

  // refetch(목록+미읽 카운트)가 로컬에서 수십 ms 에 끝나면 스피너가 expect 폴링
  // 사이에 증발한다 — 활동 API 응답을 700ms 지연시켜 출현을 결정적으로 만든다.
  await page.route(/\/me\/activity/, async (route) => {
    await new Promise((res) => setTimeout(res, 700));
    await route.continue();
  });

  // scrollTop 0 에서 시작한 합성 당김: touchstart y=200 → touchmove y=320 →
  // touchend(dy=120 > 임계 60) — usePullToRefresh 가 changedTouches 로 판정한다.
  await body.evaluate(async (el) => {
    const target = el as HTMLElement;
    const fire = (type: string, y: number): void => {
      const touch = new Touch({ identifier: 6, target, clientX: 200, clientY: y });
      target.dispatchEvent(
        new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [touch],
          targetTouches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch],
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    fire('touchstart', 200);
    await new Promise((res) => setTimeout(res, 32));
    fire('touchmove', 320);
    await new Promise((res) => setTimeout(res, 32));
    fire('touchend', 320);
  });

  const ptr = page.getByTestId('mobile-activity-ptr');
  await expect(ptr).toBeVisible();
  await expect(ptr.locator('.qf-m-ptr__spin')).toBeAttached();
  // refetch 정착(지연 700ms) 후 스피너 소멸.
  await expect(ptr).toBeHidden({ timeout: 10_000 });

  await context.close();
});

test('④ add-friend sheet — enter motion class present; grab drag dismisses', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `m6s-${stamp.toString(36)}`;
  const email = `m6sa-${stamp}@qufox.dev`;
  const token = await signupToken(request, email, `m6sa${stamp}`);
  await bootstrapWorkspace(request, token, { name: 'M6 Sheet', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, email, slug);
  await page.goto('/friends');
  await page.getByTestId('mobile-friends-fab').click();

  const sheetRoot = page.getByTestId('mobile-friends-add-sheet');
  await expect(sheetRoot).toBeVisible();
  // 등장 모션(H7)은 reduced-motion 전역 가드로 재생 검증이 불가 — enter-only
  // 클래스(qfa-sheet-in/qfa-backdrop-in) 부착만 단언한다.
  await expect(sheetRoot.locator('.qf-m-sheet')).toHaveClass(/qfa-sheet-in/);
  await expect(sheetRoot.locator('.qf-m-sheet-backdrop')).toHaveClass(/qfa-backdrop-in/);

  // grab 드래그 닫기(H8): grab 핸들에 합성 하향 드래그(dy 80 ≥ 임계 60) →
  // useSheetDragDismiss 가 onClose 를 커밋해 시트가 언마운트된다.
  await sheetRoot.locator('.qf-m-sheet__grab').evaluate(async (el) => {
    const target = el as HTMLElement;
    const fire = (type: string, y: number): void => {
      const touch = new Touch({ identifier: 7, target, clientX: 195, clientY: y });
      target.dispatchEvent(
        new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [touch],
          targetTouches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch],
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    const rect = target.getBoundingClientRect();
    const y0 = rect.top + rect.height / 2;
    fire('touchstart', y0);
    for (let dy = 16; dy <= 80; dy += 16) {
      fire('touchmove', y0 + dy);
      await new Promise((res) => setTimeout(res, 16));
    }
    fire('touchend', y0 + 80);
  });
  await expect(sheetRoot).toHaveCount(0);

  await context.close();
});
