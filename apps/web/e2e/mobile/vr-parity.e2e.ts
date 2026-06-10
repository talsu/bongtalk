import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT,
  MOBILE_VIEWPORT_PRO,
  bootstrapWorkspace,
  loginUI,
  signupToken,
} from './_helpers';

/**
 * Task-024 Chunk I: VR parity. Renders the seeded mobile shell at
 * iPhone SE (375×667) and iPhone 14 (390×844) and snapshots a stable
 * sub-tree. Threshold matches ds-mockup-parity — we want real
 * regressions (missing tabbar, topbar layout flip) to blow this up,
 * not 1-2% antialiasing drift.
 *
 * task-049: **`test.fixme` 처리** — 이 spec 은 `mobile-shell-{iphone-se,
 * iphone-14}.png` baseline 이 디스크에 한 번도 commit 된 적이 없어
 * (`-snapshots/` 에 README.md 만), `--project=chromium` CI 에서
 * "snapshot doesn't exist" 로 상시 fail 해 왔다 (049 와 무관한 선행
 * 부채, reviewer finding #1). baseline 은 인증된 live mobile shell 을
 * 캡처해야 하므로 fixture signup + 테스트 스택(docker-compose.test.yml)
 * 이 필요한데, live prod NAS 는 host port 5432/6379 를 prod
 * postgres/redis 가 점유 중이라 테스트 스택을 안전하게 기동할 수 없다.
 * → CI 그린화를 위해 명시 skip, baseline 시드는 CI/테스트 스택 환경에서
 * 수행하도록 분리: `TODO(task-049-follow-vr-parity-baseline)`.
 */
const THRESHOLD = Number(process.env.DS_PARITY_THRESHOLD ?? 0.02);

test.setTimeout(90_000);

for (const { name, viewport } of [
  { name: 'iphone-se', viewport: MOBILE_VIEWPORT },
  { name: 'iphone-14', viewport: MOBILE_VIEWPORT_PRO },
] as const) {
  // 071-M0 C12: task-049-follow-vr-parity-baseline 해소 — 테스트 스택(빌드본 45173)에서
  // baseline 시드 완료, fixme 해제. reseed 는 동일 스택에서 --update-snapshots 로.
  test(
    `mobile shell renders stably at ${name} (${viewport.width}×${viewport.height})`,
    async ({ browser, request }) => {
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

      await context.close();
    },
  );
}
