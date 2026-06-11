import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  MOBILE_VIEWPORT_PRO,
  apiSendMessage,
  bootstrapWorkspace,
  dispatchLongPress,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * 071-M6 T2 — axe-core 모바일 표면 스윕(390×844).
 *
 * 데스크톱 선례(e2e/a11y/axe-scan.e2e.ts)의 AxeBuilder 패턴을 모바일 5표면으로
 * 확장한다. 각 표면을 스캔해 critical/serious 임팩트 위반 0 을 단언한다.
 *
 *  (a) 채팅 화면 + 탭바        — 로그인 직후 채널 라우트(메시지 리스트 + 5탭).
 *  (b) 좌패널 열림             — OverlappingPanels data-open="left" + server-header.
 *  (c) 메시지 롱프레스 시트     — mobile-msg-sheet-* 바텀시트 오픈 상태.
 *  (d) '나' 탭                — mobile-you-tab 화면.
 *  (e) 워크스페이스 설정 풀스크린 — 서버 메뉴 → /w/:slug/settings (OWNER).
 *
 * ── 위반 격리 백로그(071-M6 T2) ─────────────────────────────────────────
 * ISOLATED_RULES 는 "실측으로 확인된 기존 위반"만 룰 단위로 격리하는 자리다.
 * 무단 전체 skip 금지 — 위반 룰 id + 표면 + 사유를 아래 표에 기록하고
 * 후속 수리 태스크로 백로그화한다. 모든 스캔은 임팩트 무관 전체 위반 목록을
 * 콘솔에 출력하므로(triage 용), 첫 실측 실행 로그가 곧 기록 근거다.
 *
 *  | rule id | 표면 | 사유/백로그 |
 *  |---------|------|------------|
 *  | color-contrast | left-panel(.qf-m-section__action) · you-tab(.qf-avatar 이니셜) · ws-settings(workspace-settings-save) | DS 4파일 소유 색 조합(serious) — DS frozen 이라 앱 레이어 수리 불가, DS 토큰 개정 백로그(사용자 결정 필요). 앱 소유였던 레일 활성 텍스트 1건과 aria-allowed-attr(탭바 role·채널행 aria-current)는 M6 T5 에서 코드 수리 완료 |
 * ────────────────────────────────────────────────────────────────────────
 */
test.setTimeout(180_000);

// 실측으로 확인된 기존 위반 룰만 명시 격리한다(위 백로그 표와 1:1 동기).
const ISOLATED_RULES: string[] = ['color-contrast'];

// 데스크톱 선례(axe-scan.e2e.ts)와 동일: Radix 가 포털 애니메이션 중 일시적으로
// 거는 aria-hidden 이 만드는 프레임워크 오탐 — 실제 장벽이 아니므로 차단 집계에서
// 제외한다(콘솔 triage 출력에는 그대로 남는다).
const KNOWN_FALSE_POSITIVES: readonly string[] = ['aria-hidden-focus'];

type AxeViolation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number];

/**
 * 표면 1개를 axe 로 스캔한다.
 *  - 전체 위반(임팩트 무관)을 콘솔에 출력해 백로그 triage 근거를 남기고,
 *  - critical/serious 위반(오탐 제외)만 expect.soft 로 0 단언한다.
 * expect.soft 인 이유: 한 표면의 위반이 뒤 표면 스캔을 가로막으면 첫 실측에서
 * 5표면 전체 위반 목록을 한 번에 얻을 수 없다(soft 도 테스트는 fail 처리).
 */
async function scanSurface(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).disableRules([...ISOLATED_RULES]).analyze();
  if (results.violations.length > 0) {
    const triage = results.violations.map((v: AxeViolation) => ({
      id: v.id,
      impact: v.impact ?? 'unknown',
      help: v.help,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
    }));
    console.log(
      `[axe:${label}] 위반 ${results.violations.length}건:\n${JSON.stringify(triage, null, 2)}`,
    );
  }
  const blocking = results.violations.filter(
    (v: AxeViolation) =>
      (v.impact === 'critical' || v.impact === 'serious') && !KNOWN_FALSE_POSITIVES.includes(v.id),
  );
  expect
    .soft(blocking, `[axe:${label}] critical/serious 위반:\n${JSON.stringify(blocking, null, 2)}`)
    .toHaveLength(0);
}

test('axe sweep — chat screen + tabbar / left panel / long-press sheet', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `axm-${stamp.toString(36)}`;
  const token = await signupToken(request, `axma-${stamp}@qufox.dev`, `axma${stamp}`);
  const { workspaceId, channelIds } = await bootstrapWorkspace(request, token, {
    name: 'AxeMobile',
    slug,
    channels: ['general'],
  });
  // 콘텐츠가 있는 실표면을 스캔한다(빈 리스트 스캔은 표면 커버리지가 빈약).
  await apiSendMessage(request, token, workspaceId, channelIds.general!, 'axe 스윕 표적 메시지');
  await apiSendMessage(request, token, workspaceId, channelIds.general!, '두 번째 메시지');

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `axma-${stamp}@qufox.dev`, slug);

  // (a) 채팅 화면 + 탭바 — 메시지/탭바 렌더 정착 후 스캔.
  await expect(page.getByTestId('mobile-message-list')).toContainText('axe 스윕 표적 메시지');
  await expect(page.getByTestId('mobile-tabbar')).toBeVisible();
  await scanSurface(page, 'chat+tabbar');

  // (b) 좌패널 열림 — server-header 까지 보인 뒤 스캔.
  await page.getByTestId('mobile-topbar-menu').click();
  await expect(page.getByTestId('mobile-panels')).toHaveAttribute('data-open', 'left');
  await expect(page.getByTestId('mobile-server-header')).toBeVisible();
  await scanSurface(page, 'left-panel');

  // 스크림 탭으로 패널 정리(panels.e2e.ts 관행) 후 시트 단계로.
  await page.getByTestId('mobile-panel-scrim').click({ position: { x: 300, y: 400 }, force: true });
  await expect(page.getByTestId('mobile-panels')).toHaveAttribute('data-open', 'center');

  // (c) 메시지 롱프레스 시트 — 확정 행(tmp- 제외)만 잡아 dispatch 증발 방지
  // (long-press-sheet.e2e.ts 관행, ensureVisible 재시도 포함).
  const row = page
    .getByTestId('mobile-message-list')
    .locator('[data-testid^="mobile-msg-"]:not([data-testid^="mobile-msg-tmp-"])')
    .first();
  await expect(row).toBeVisible();
  const sheet = page.locator('[data-testid^="mobile-msg-sheet-"]').first();
  await dispatchLongPress(row, 650, sheet);
  await expect(sheet).toBeVisible();
  await scanSurface(page, 'long-press-sheet');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  await context.close();
});

test('axe sweep — you tab / workspace settings fullscreen', async ({ browser, request }) => {
  const stamp = Date.now();
  const slug = `axs-${stamp.toString(36)}`;
  // 워크스페이스 설정 진입은 OWNER 만 가능(m3-server-menu.e2e.ts) — 소유자로 시드.
  const token = await signupToken(request, `axsa-${stamp}@qufox.dev`, `axsa${stamp}`);
  await bootstrapWorkspace(request, token, { name: 'AxeMobileS', slug, channels: ['general'] });

  const context = await browser.newContext({ viewport: MOBILE_VIEWPORT_PRO, hasTouch: true });
  const page = await context.newPage();
  await loginUI(page, `axsa-${stamp}@qufox.dev`, slug);

  // (d) '나' 탭 — 상태/로그아웃 행 렌더 정착 후 스캔(five-tabs.e2e.ts 관행).
  await page.getByTestId('mobile-tab-you').click();
  await expect(page.getByTestId('mobile-you-tab')).toBeVisible();
  await expect(page.getByTestId('mobile-you-status')).toBeVisible();
  await scanSurface(page, 'you-tab');

  // (e) 워크스페이스 설정 풀스크린 — 검증된 UI 경로(서버 메뉴 시트 → 설정)로 진입
  // (m3-server-menu.e2e.ts: /w/:slug/settings 직마운트, 채널로 안 튕김).
  await page.getByTestId('mobile-tab-chat').click();
  await expect(page.getByTestId('mobile-tabbar')).toBeVisible();
  await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('mobile-server-menu-trigger').click();
  await expect(page.getByTestId('mobile-server-menu-sheet')).toBeVisible();
  await page.getByTestId('mobile-server-menu-settings').click();
  await page.waitForURL(new RegExp(`/w/${slug}/settings$`));
  await expect(page.getByTestId('mobile-ws-settings')).toBeVisible();
  await expect(page.getByTestId('ws-settings-tab-general')).toBeVisible();
  await scanSurface(page, 'ws-settings');

  await context.close();
});
