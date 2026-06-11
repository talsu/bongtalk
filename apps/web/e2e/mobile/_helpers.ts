import type { APIRequestContext, Page } from '@playwright/test';

export const PW = 'Quanta-Beetle-Nebula-42!';
export const API = 'http://localhost:43001';
export const ORIGIN = 'http://localhost:45173';

export const MOBILE_VIEWPORT = { width: 375, height: 667 } as const; // iPhone SE
export const MOBILE_VIEWPORT_PRO = { width: 390, height: 844 } as const; // iPhone 13/14
// task-040 R5: pixel-class viewport for the wider mobile band (iPhone XR / Plus).
export const MOBILE_VIEWPORT_XR = { width: 414, height: 896 } as const; // iPhone XR / 11
// task-042 R5: tablet portrait (iPad mini portrait, 768 wide). At
// exactly 768 the desktop shell mounts (App's matchMedia is `(max-
// width: 767px)`), so this band tests the narrowest desktop layout.
// Useful for catching desktop shell bugs that only appear under
// 800-900 widths. Listed in MOBILE_VIEWPORTS because the helper
// constant location matches the dim sweep convention; it is
// effectively a "narrow-desktop" probe.
export const TABLET_VIEWPORT_PORTRAIT = { width: 768, height: 1024 } as const;
export const MOBILE_VIEWPORTS = [
  MOBILE_VIEWPORT,
  MOBILE_VIEWPORT_PRO,
  MOBILE_VIEWPORT_XR,
  TABLET_VIEWPORT_PORTRAIT,
] as const;

export async function signupToken(
  request: APIRequestContext,
  email: string,
  username: string,
): Promise<string> {
  const r = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username, password: PW },
  });
  if (!r.ok()) throw new Error(`signup failed: ${r.status()} ${await r.text()}`);
  // 071-M0 C12: S66 이후 미인증 계정은 /w/* UI 게이트 + 메시지 전송 403 에 막힌다.
  // 테스트 스택 전용 훅(E2E_TEST_HOOKS=1)으로 인증을 완료시킨다.
  const v = await request.post(`${API}/auth/test-hooks/verify-email`, {
    headers: { origin: ORIGIN },
    data: { email },
  });
  if (!v.ok()) throw new Error(`test verify-email failed: ${v.status()} ${await v.text()}`);
  return ((await r.json()) as { accessToken: string }).accessToken;
}

export async function bootstrapWorkspace(
  request: APIRequestContext,
  token: string,
  opts: { name: string; slug: string; channels: string[] },
): Promise<{ workspaceId: string; channelIds: Record<string, string> }> {
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: opts.name, slug: opts.slug },
  });
  const wsId = ((await ws.json()) as { id: string }).id;
  // 071-M0 C12: 워크스페이스 생성이 'general' 채널을 자동 생성하게 된 뒤, 종전의
  // 무검사 생성은 CHANNEL_NAME_TAKEN 응답에서 undefined id 를 받아
  // channelIds.general=undefined → 시드 POST 가 /channels/undefined/... 로 전멸했다.
  // 생성 실패(이미 존재)는 무시하고, 최종 id 매핑은 GET 채널 목록에서 만든다.
  for (const name of opts.channels) {
    await request.post(`${API}/workspaces/${wsId}/channels`, {
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      data: { name, type: 'TEXT' },
    });
  }
  const listRes = await request.get(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
  });
  const list = (await listRes.json()) as {
    uncategorized: Array<{ id: string; name: string }>;
    categories: Array<{ channels: Array<{ id: string; name: string }> }>;
  };
  const channelIds: Record<string, string> = {};
  for (const c of [
    ...(list.uncategorized ?? []),
    ...(list.categories ?? []).flatMap((x) => x.channels),
  ]) {
    channelIds[c.name] = c.id;
  }
  // 리뷰 L1: NAME_TAKEN 외의 생성 실패(rate limit 등)가 침묵 통과하면 종전의
  // `/channels/undefined` 시드 전멸이 재발한다 — 요청 채널 전원이 매핑됐는지 확인.
  for (const name of opts.channels) {
    if (!channelIds[name]) {
      throw new Error(
        `bootstrapWorkspace: channel "${name}" missing after create+list (got: ${Object.keys(channelIds).join(',')})`,
      );
    }
  }
  return { workspaceId: wsId, channelIds };
}

// 071-M1 D11: 멤버 초대+가입(2인 시나리오 공용).
export async function inviteAndJoin(
  request: APIRequestContext,
  ownerToken: string,
  workspaceId: string,
  memberToken: string,
): Promise<void> {
  const inv = await request.post(`${API}/workspaces/${workspaceId}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: {},
  });
  if (!inv.ok()) throw new Error(`invite create failed: ${inv.status()}`);
  const code = ((await inv.json()) as { invite: { code: string } }).invite.code;
  const acc = await request.post(`${API}/invites/${code}/accept`, {
    headers: { authorization: `Bearer ${memberToken}`, origin: ORIGIN },
    data: {},
  });
  if (!acc.ok()) throw new Error(`invite accept failed: ${acc.status()}`);
}

// 071-M1 D11: API 메시지 시드(반환: message id).
export async function apiSendMessage(
  request: APIRequestContext,
  token: string,
  workspaceId: string,
  channelId: string,
  content: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  const r = await request.post(`${API}/workspaces/${workspaceId}/channels/${channelId}/messages`, {
    headers: {
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content, ...(extra ?? {}) },
  });
  if (!r.ok()) throw new Error(`send failed: ${r.status()} ${await r.text()}`);
  const body = (await r.json()) as { message?: { id: string }; id?: string };
  return body.message?.id ?? body.id ?? '';
}

// 071-M1 D11: 롱프레스 시뮬레이션 — MobileMessageRow 의 setTimeout(500) 발화.
// Playwright Chromium 은 네이티브 long-press 제스처가 없어 TouchEvent 를 합성한다.
// 낙관적(tmp-) 행이 확정 스왑으로 detach 되는 찰나의 dispatch 증발을 피하려면
// 호출측이 확정 행 선택자(:not([data-testid^="mobile-msg-tmp-"]))를 써야 한다.
export async function dispatchLongPress(
  locator: ReturnType<Page['locator']>,
  holdMs = 650,
  // 071-M5 S6 (M6 선취): 부하 시 React 리렌더가 dispatch 직후 리스너를 detach
  // 하면 이벤트가 조용히 증발한다(반복 flake 근원). 기대 표면 셀렉터를 주면
  // 미출현 시 1회 재디스패치한다.
  ensureVisible?: ReturnType<Page['locator']>,
): Promise<void> {
  const fire = async (): Promise<void> => {
    await locator.evaluate((el) => {
      const target = el as HTMLElement;
      const rect = target.getBoundingClientRect();
      const touch = new Touch({
        identifier: 1,
        target,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      });
      target.dispatchEvent(
        new TouchEvent('touchstart', {
          touches: [touch],
          targetTouches: [touch],
          changedTouches: [touch],
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await locator.page().waitForTimeout(holdMs);
  };
  await fire();
  if (ensureVisible) {
    if (await ensureVisible.count()) return;
    await fire();
  }
}

export async function loginUI(page: Page, email: string, expectedSlug: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  // 071-M0 C12: task-035 이후 로그인 랜딩은 '/'(MobileHome) — 종전의 /w/:slug 자동
  // 리다이렉트 대기는 모바일 스위트 전체를 silent-red 로 만들었다. 로그인 완료만
  // 기다린 뒤 스펙들이 기대하는 워크스페이스 셸로 명시 이동한다.
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`/w/${expectedSlug}`);
  // C11(FR-IA-WS-01): /w/:slug 는 lastChannel/기본 채널로 자동 진입하는 과도 상태다.
  // 여기서 리다이렉트가 끝나기를 기다리지 않으면, 스펙이 연 드로어가 늦은 pathname
  // 변경(자동 진입)에 의해 닫히는 레이스가 난다. 채널 라우트 정착까지 대기한다
  // (bootstrapWorkspace 로 만든 워크스페이스는 항상 채널이 있다).
  await page.waitForURL(new RegExp(`/w/${expectedSlug}/[^/?]+`));
}
