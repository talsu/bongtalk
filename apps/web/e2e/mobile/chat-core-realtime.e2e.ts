import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT_PRO,
  bootstrapWorkspace,
  inviteAndJoin,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * 071-M1 D11 — 실시간 게이트 (D7 타이핑 + D10 presence idle).
 *
 * 두 모바일 컨텍스트(하드 로드 세션)로 WS 경로를 관통 검증한다 — M1 에서 수리한
 * useRealtimeConnection deps 잠복 버그(하드 로드 세션 WS 영구 미연결)의 회귀 가드를
 * 겸한다. presence idle 은 테스트 스택의 PRESENCE_IDLE_TIMEOUT=5/SWEEP=1000 가속을
 * 전제한다(docker-compose.test.yml / e2e-audit.yml).
 */
test.setTimeout(120_000);

test('typing indicator shows on the peer screen while the other member types', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `mrt-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `mrta-${stamp}@qufox.dev`, `mrta${stamp}`);
  const bTok = await signupToken(request, `mrtb-${stamp}@qufox.dev`, `mrtb${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, aTok, {
    name: 'M1 Typing',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);

  const ctxA = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const pa = await ctxA.newPage();
  await loginUI(pa, `mrta-${stamp}@qufox.dev`, slug);

  const ctxB = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const pb = await ctxB.newPage();
  await loginUI(pb, `mrtb-${stamp}@qufox.dev`, slug);

  await pb.getByTestId('mobile-msg-input').click();
  await pb.getByTestId('mobile-msg-input').pressSequentially('지금 입력하는 중입니다', {
    delay: 60,
  });

  await expect(pa.locator(`[data-testid="typing-indicator-${channelIds.general}"]`)).toBeVisible({
    timeout: 10_000,
  });

  await ctxA.close();
  await ctxB.close();
});

test('inactive member transitions to idle and shows the idle dot in the member drawer', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `mri-${stamp.toString(36)}`;
  const bUsername = `mrib${stamp}`;
  const aTok = await signupToken(request, `mria-${stamp}@qufox.dev`, `mria${stamp}`);
  const bTok = await signupToken(request, `mrib-${stamp}@qufox.dev`, bUsername);
  const { workspaceId } = await bootstrapWorkspace(request, aTok, {
    name: 'M1 Idle',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);

  // b: 접속 후 무활동(터치/마우스/키 입력 없음) → 5s 타임아웃 + 1s sweep 후 IDLE.
  const ctxB = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const pb = await ctxB.newPage();
  await loginUI(pb, `mrib-${stamp}@qufox.dev`, slug);

  const ctxA = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const pa = await ctxA.newPage();
  await loginUI(pa, `mria-${stamp}@qufox.dev`, slug);

  // idle 전이 대기 후 멤버 드로어 오픈(뷰포트 진입 시 presence:subscribe).
  await pa.waitForTimeout(8_000);
  await pa.getByTestId('mobile-topbar-members').click();
  const bRow = pa.locator(`[data-testid="mobile-member-${bUsername}"]`);
  await expect(bRow).toBeVisible();
  // D10: idle 멤버는 '오프라인' 그룹이 아닌 접속 버킷에 노랑 닷으로 표시된다.
  await expect(bRow).toHaveAttribute('data-presence', 'idle', { timeout: 15_000 });
  await expect(bRow.locator('.qf-avatar__status--idle')).toHaveCount(1);

  await ctxA.close();
  await ctxB.close();
});
