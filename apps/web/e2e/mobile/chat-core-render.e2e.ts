import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT_PRO,
  apiSendMessage,
  bootstrapWorkspace,
  inviteAndJoin,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * 071-M1 D11 — 채팅 코어 렌더 게이트.
 *
 * D1/D2/D6 의 시각 프로브 시나리오를 회귀 게이트로 고정한다:
 *   - 같은 작성자 연속 메시지 그루핑(--head/--cont)
 *   - 날짜 구분선(day divider)
 *   - 리액션 칩 행(44px 터치 플로어 포함)
 *   - 스레드 chip
 *   - 신규 진입 멤버의 미읽음 구분선 + 하단 이탈 중 신규 도착 시 jump 버튼
 */
test.setTimeout(120_000);

test('grouping/day divider/reaction chips/thread chip render on mobile rows', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `mcr-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `mcra-${stamp}@qufox.dev`, `mcra${stamp}`);
  const bTok = await signupToken(request, `mcrb-${stamp}@qufox.dev`, `mcrb${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, aTok, {
    name: 'M1 Render',
    slug,
    channels: ['general'],
  });
  await inviteAndJoin(request, aTok, workspaceId, bTok);

  await apiSendMessage(request, bTok, workspaceId, channelIds.general!, '그루핑 1');
  await apiSendMessage(request, bTok, workspaceId, channelIds.general!, '그루핑 2');
  await apiSendMessage(request, bTok, workspaceId, channelIds.general!, '그루핑 3');
  const aMsg = await apiSendMessage(
    request,
    aTok,
    workspaceId,
    channelIds.general!,
    '리액션/스레드 대상',
  );
  await request.post(`http://localhost:43001/messages/${aMsg}/reactions`, {
    headers: {
      authorization: `Bearer ${bTok}`,
      origin: 'http://localhost:45173',
      'idempotency-key': crypto.randomUUID(),
    },
    data: { emoji: '👍' },
  });
  await apiSendMessage(request, bTok, workspaceId, channelIds.general!, '스레드 답글', {
    parentMessageId: aMsg,
  });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `mcra-${stamp}@qufox.dev`, slug);
  await expect(page.getByTestId('mobile-message-list')).toContainText('그루핑 3');

  // 그루핑: b 연속 3건 중 2건은 --cont(아바타/헤더 숨김), 첫 건은 --head.
  expect(await page.locator('.qf-m-msg--cont').count()).toBeGreaterThanOrEqual(2);
  expect(await page.locator('.qf-m-msg--head').count()).toBeGreaterThanOrEqual(2);
  // 날짜 구분선: 오늘 1개.
  await expect(page.locator('[data-testid^="day-divider-"]')).toHaveCount(1);
  // 리액션 칩: 노출 + 44px 터치 플로어(PRD D05 모바일 mock).
  const chip = page.locator('.qf-reaction').first();
  await expect(chip).toBeVisible();
  const box = await chip.boundingBox();
  expect(box && box.height).toBeGreaterThanOrEqual(44);
  // 스레드 chip: 답글 1개 달린 루트 행에 노출.
  await expect(page.locator('[data-testid^="mobile-thread-chip-"]').first()).toBeVisible();

  await context.close();
});

test('unread divider for a newly joined member + jump button on new arrivals', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `mcj-${stamp.toString(36)}`;
  const aTok = await signupToken(request, `mcja-${stamp}@qufox.dev`, `mcja${stamp}`);
  const cTok = await signupToken(request, `mcjc-${stamp}@qufox.dev`, `mcjc${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, aTok, {
    name: 'M1 Jump',
    slug,
    channels: ['general'],
  });
  // 긴 히스토리(스크롤 가능)를 먼저 깐 뒤 c 가입 → 가입 후 3건 더(미읽음 표적).
  for (let i = 1; i <= 30; i++) {
    await apiSendMessage(request, aTok, workspaceId, channelIds.general!, `히스토리 ${i}`);
  }
  await inviteAndJoin(request, aTok, workspaceId, cTok);
  for (let i = 1; i <= 3; i++) {
    await apiSendMessage(request, aTok, workspaceId, channelIds.general!, `미읽 표적 ${i}`);
  }

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `mcjc-${stamp}@qufox.dev`, slug);
  await expect(page.getByTestId('mobile-message-list')).toContainText('미읽 표적 3');

  // D6(FR-RS-06): 채널 진입 스냅샷 기준 '새 메시지' 경계선.
  await expect(page.getByTestId('mobile-unread-divider')).toBeVisible();

  // D6(FR-RS-07 단순화): 위로 이탈 → 신규 도착 → jump 버튼 + 배지 → 탭 → 하단 복귀.
  const list = page.getByTestId('mobile-message-list');
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  await apiSendMessage(request, aTok, workspaceId, channelIds.general!, '점프 트리거');
  await expect(page.getByTestId('mobile-jump-btn')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('mobile-jump-btn').click();
  await expect(page.getByTestId('mobile-jump-btn')).toHaveCount(0);
  const atBottom = await list.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60,
  );
  expect(atBottom).toBe(true);

  await context.close();
});
