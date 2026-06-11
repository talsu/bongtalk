import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORTS, PW, bootstrapWorkspace, loginUI, signupToken } from './_helpers';

/**
 * Task-024 Chunk I: VR parity. Renders the seeded shell at the four
 * MOBILE_VIEWPORTS dims and snapshots a stable sub-tree. Threshold
 * matches ds-mockup-parity — we want real regressions (missing tabbar,
 * topbar layout flip) to blow this up, not 1-2% antialiasing drift.
 *
 * task-049: 한때 baseline 부재로 `test.fixme` 였으나 071-M0 C12 에서
 * 테스트 스택(빌드본 45173) 기준 iphone-se/iphone-14 baseline 을 시드해
 * 해제했다. reseed 는 동일 스택에서 `--update-snapshots` 로.
 *
 * 071-M6 T3: 4뷰포트로 확장 — 기존 iphone-se(375×667)/iphone-14(390×844)
 * 에 iphone-xr(414×896)/tablet-portrait(768×1024) 를 추가한다
 * (_helpers MOBILE_VIEWPORTS 재사용).
 *
 * M6 T3 에서 4뷰포트로 확장 — 신규 2뷰포트(iphone-xr / tablet-portrait)
 * baseline 은 cf2bb55 에서 시드 완료(테스트 스택 빌드본 기준). reseed 는 셸
 * 의도 변경 시에만 동일 스택에서 `--update-snapshots` — diff 이미지 검수 없이
 * 기계적으로 재생성하면 회귀가 baseline 으로 봉인되므로 금지(M6 리뷰 M-7).
 */
const THRESHOLD = Number(process.env.DS_PARITY_THRESHOLD ?? 0.02);

test.setTimeout(90_000);

// 071-M6 T3: MOBILE_VIEWPORTS(스윕 순서 고정: se → pro → xr → tablet)에
// 스냅샷 파일명을 짝지운다. 헬퍼에 뷰포트가 추가되면 여기도 갱신할 것.
const CASES = [
  { name: 'iphone-se', viewport: MOBILE_VIEWPORTS[0] },
  { name: 'iphone-14', viewport: MOBILE_VIEWPORTS[1] },
  { name: 'iphone-xr', viewport: MOBILE_VIEWPORTS[2] },
  { name: 'tablet-portrait', viewport: MOBILE_VIEWPORTS[3] },
] as const;

for (const { name, viewport } of CASES) {
  // 768 경계: 데스크톱 셸 분기 (위 헤더 주석 참조).
  const isDesktopShell = viewport.width >= 768;

  test(`${isDesktopShell ? 'desktop' : 'mobile'} shell renders stably at ${name} (${viewport.width}×${viewport.height})`, async ({
    browser,
    request,
  }) => {
    const stamp = Date.now();
    const email = `mb-vr-${name}-${stamp}@qufox.dev`;
    const username = `mbvr${name.replace(/-/g, '')}${stamp}`;
    const slug = `mb-vr-${name}-${stamp.toString(36)}`;

    const token = await signupToken(request, email, username);
    await bootstrapWorkspace(request, token, {
      name: `VR ${name}`,
      slug,
      channels: ['general'],
    });

    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    if (isDesktopShell) {
      // 071-M6 T3: loginUI 의 마지막 waitForURL 은 모바일 셸의 채널 자동
      // 진입(FR-IA-WS-01, MobileShell 전용)에 의존한다 — 데스크톱 셸의
      // `/w/:slug` 는 "채널을 선택하세요" 빈 상태로 머무르므로 여기서는
      // 로그인만 수행하고 채널 라우트로 직접 이동한다.
      await page.goto('/login');
      await page.getByTestId('login-email').fill(email);
      await page.getByTestId('login-password').fill(PW);
      await page.getByTestId('login-submit').click();
      await page.waitForURL((u) => !u.pathname.startsWith('/login'));
      await page.goto(`/w/${slug}/general`);

      // 768 에서는 데스크톱 셸이 뜨는 게 정상 — mobile-shell 이 아니라
      // shell-root 로 단언한다.
      await expect(page.getByTestId('shell-root')).toBeVisible();
      await expect(page.getByTestId('mobile-shell')).toHaveCount(0);
      // 스크린샷 전에 메시지 컬럼(빈 채널 상태)과 컴포저, BottomBar 가
      // 모두 정착하기를 기다린다 — 로딩 중간 상태 캡처 방지.
      await expect(page.getByTestId('msg-column-general')).toBeVisible();
      await expect(page.getByTestId('msg-input')).toBeVisible();
      await expect(page.getByTestId('bottom-bar')).toBeVisible();

      const shot = await page.getByTestId('shell-root').screenshot();
      expect(shot.length).toBeGreaterThan(500);
      await expect(page.getByTestId('shell-root')).toHaveScreenshot(`desktop-shell-${name}.png`, {
        maxDiffPixelRatio: THRESHOLD,
        animations: 'disabled',
        // BottomBar 는 run-unique username(타임스탬프 포함)을 노출하므로
        // 픽셀 비교에서 가린다.
        mask: [page.getByTestId('bottom-bar')],
      });
    } else {
      await loginUI(page, email, slug);

      // Land on a channel so the topbar shows channel title / members icon.
      await page.getByTestId('mobile-topbar-menu').click();
      await page.getByTestId('mobile-channel-general').click();
      await expect(page).toHaveURL(new RegExp(`/w/${slug}/general`));
      await page.getByTestId('mobile-shell').waitFor({ state: 'visible' });

      const shot = await page.getByTestId('mobile-shell').screenshot();
      expect(shot.length).toBeGreaterThan(500);
      await expect(page.getByTestId('mobile-shell')).toHaveScreenshot(`mobile-shell-${name}.png`, {
        maxDiffPixelRatio: THRESHOLD,
        animations: 'disabled',
      });
    }

    await context.close();
  });
}
