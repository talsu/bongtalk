import { test, expect } from '@playwright/test';

// S67 (D13 / FR-W02·W17): 워크스페이스 설정 → '초대 링크' 탭에서 초대 생성(임시 멤버십
// 토글 포함) → 목록 노출 → 비활성화 흐름을 검증한다. 멤버 관리 탭(S69)은 다루지 않는다.
const PW = 'Quanta-Beetle-Nebula-42!';

test.setTimeout(60_000);
test('owner manages invites: create (temporary) → list → revoke', async ({ page, context }) => {
  const stamp = Date.now();
  const slug = `inv-${stamp.toString(36)}`;
  const email = `inv-${stamp}@qufox.dev`;
  const username = `inv${stamp}`;

  // 가입 + 워크스페이스 생성 → 소유자.
  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-username').fill(username);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(username);

  await page.goto('/w/new');
  await page.getByTestId('ws-name').fill('InviteCo');
  await page.getByTestId('ws-slug').fill(slug);
  await page.getByTestId('ws-create-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // 워크스페이스 설정 진입 → '초대 링크' 탭.
  await page.goto(`/w/${slug}/settings`);
  await page.getByTestId('ws-settings-tab-invites').click();
  await expect(page.getByTestId('invite-manager')).toBeVisible();

  // 초대 생성(임시 멤버십 토글 on).
  await page.getByTestId('invite-create-open').click();
  await expect(page.getByTestId('create-invite-form')).toBeVisible();
  await page.getByTestId('invite-max-uses').selectOption('5');
  await page.getByTestId('invite-temporary').check();
  await page.getByTestId('create-invite-submit').click();

  // 목록에 1건 노출 + 활성 상태.
  const row = page.getByTestId('invite-row').first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId('invite-status')).toHaveText('활성');

  // 비활성화(soft revoke) → 상태가 비활성으로 전환.
  await row.getByTestId('invite-revoke').click();
  await expect(page.getByTestId('invite-row').first().getByTestId('invite-status')).toHaveText(
    '비활성',
  );
});
