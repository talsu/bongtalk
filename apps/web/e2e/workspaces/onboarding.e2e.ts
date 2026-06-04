import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';

/**
 * S71 (D13 / FR-W07·W08·W09·W09a): 워크스페이스 온보딩 e2e.
 *
 *   1. 생성자(OWNER) 첫 진입 시 빈 기본 채널 empty state + 생성자 CTA 가 렌더된다(FR-W09a AC).
 *   2. OWNER 가 규칙/질문/웰컴을 설정한 뒤, 새 멤버가 합류하면 온보딩 3단계
 *      (규칙 동의 → 관심사 → 웰컴) 전체화면 모달이 순서대로 진행된다(happy path).
 */
test.setTimeout(90_000);
test('생성자 CTA + 신규 멤버 온보딩 3단계 happy path', async ({ page, browser }) => {
  const stamp = Date.now();
  const slug = `onb-${stamp.toString(36)}`;

  // --- OWNER: signup → create workspace ---
  const emailA = `obo-${stamp}@qufox.dev`;
  const usernameA = `obo${stamp}`;
  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(emailA);
  await page.getByTestId('signup-username').fill(usernameA);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(usernameA);

  await page.goto('/w/new');
  await page.getByTestId('ws-name').fill('OnbWs');
  await page.getByTestId('ws-slug').fill(slug);
  await page.getByTestId('ws-create-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));
  await expect(page.getByTestId('ws-my-role')).toHaveText('OWNER');

  // --- FR-W09a AC: 빈 기본 채널 empty state + 생성자 CTA 가 보인다 ---
  await expect(page.getByTestId('channel-empty')).toBeVisible();
  await expect(page.getByTestId('creator-empty-cta')).toBeVisible();
  await expect(page.getByTestId('creator-cta-invite')).toBeVisible();

  const baseURL = page.url().replace(/\/w\/.*$/, '');

  // --- OWNER: 온보딩 설정(규칙 + 질문 + 웰컴) ---
  await page.goto(`${baseURL}/w/${slug}/settings`);
  await page.getByTestId('ws-settings-tab-onboarding').click();
  await page.getByTestId('rule-title-input').fill('서로 존중하기');
  await page.getByTestId('rule-add').click();
  await expect(page.getByText('서로 존중하기')).toBeVisible();
  await page.getByTestId('question-label-input').fill('어떤 일을 하시나요?');
  await page.getByTestId('question-add').click();
  await expect(page.getByText('어떤 일을 하시나요?')).toBeVisible();
  await page.getByTestId('welcome-message-input').fill('환영합니다!');
  await page.getByTestId('welcome-save').click();

  // --- OWNER: 초대 코드 생성(워크스페이스 nav 의 invite 버튼 — create-and-invite e2e 선례) ---
  await page.goto(`${baseURL}/w/${slug}`);
  await page.getByTestId('ws-invite').click();
  await expect(page.getByTestId('ws-invite-url')).toBeVisible();
  const inviteUrl = (await page.getByTestId('ws-invite-url').textContent()) ?? '';
  const code = inviteUrl.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
  expect(code).toBeTruthy();

  // --- 신규 멤버 B: signup → 초대 수락 → 온보딩 3단계 ---
  const bCtx = await browser.newContext();
  const bPage = await bCtx.newPage();
  const emailB = `obm-${stamp}@qufox.dev`;
  const usernameB = `obm${stamp}`;
  await bPage.goto(`${baseURL}/signup`);
  await bPage.getByTestId('signup-email').fill(emailB);
  await bPage.getByTestId('signup-username').fill(usernameB);
  await bPage.getByTestId('signup-password').fill(PW);
  await bPage.getByTestId('signup-submit').click();
  await expect(bPage.getByTestId('home-username')).toHaveText(usernameB);

  await bPage.goto(`${baseURL}/invite/${code}`);
  await bPage.getByTestId('invite-accept').click();
  await expect(bPage).toHaveURL(new RegExp(`/w/${slug}$`));

  // Step1: 규칙 동의 모달 — 체크 후 동의.
  await expect(bPage.getByTestId('onboarding-step-rules')).toBeVisible();
  await bPage.getByTestId('rule-check-0').check();
  await bPage.getByTestId('onboarding-accept-rules').click();

  // Step2: 관심사 — 건너뛰기로 완료.
  await expect(bPage.getByTestId('onboarding-step-interests')).toBeVisible();
  await bPage.getByTestId('onboarding-skip').click();

  // Step3: 웰컴 — 시작하기로 닫기.
  await expect(bPage.getByTestId('onboarding-step-welcome')).toBeVisible();
  await bPage.getByTestId('onboarding-done').click();

  // 온보딩 모달이 닫히고 채널 화면으로 진입.
  await expect(bPage.getByTestId('onboarding-step-welcome')).toBeHidden();

  await bCtx.close();
});
