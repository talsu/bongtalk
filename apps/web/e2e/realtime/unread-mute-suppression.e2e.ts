import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(120_000);

async function signupAndGetToken(
  context: BrowserContext,
  email: string,
  username: string,
): Promise<string> {
  const req = await context.request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username, password: PW },
  });
  if (!req.ok()) throw new Error(`signup failed: ${req.status()} ${await req.text()}`);
  return ((await req.json()) as { accessToken: string }).accessToken;
}

async function loginInPage(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('[data-testid=login-email]', email);
  await page.fill('[data-testid=login-password]', PW);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL('**');
}

/**
 * S22 (review #1, FR-RS-05): 뮤트 억제 회귀 가드.
 *
 * 뮤트한 채널은 일반 미읽음(`data-unread`)을 억제하되, 본인을 향한 멘션은
 * 그대로 뱃지로 노출해야 한다(뮤트는 미읽음 표시만 억제, 멘션은 유지).
 *
 *  - member 가 #general 을 무기한 뮤트한다(POST /me/mutes/channels/:id).
 *  - member 는 #offtopic 을 보고 있어 #general 은 비활성.
 *  - owner 가 #general 에 일반 메시지 → #general 행은 `data-unread=false` 유지.
 *  - owner 가 member 를 @멘션 → 멘션 숫자 뱃지(unread-pill-mention)는 노출.
 */
test('muted channel suppresses unread but still surfaces mention badge', async ({ browser }) => {
  const stamp = Date.now();
  const ownerCtx = await browser.newContext();
  const memberCtx = await browser.newContext();

  const ownerToken = await signupAndGetToken(
    ownerCtx,
    `mu-own-${stamp}@qufox.dev`,
    `muown${stamp}`,
  );
  const memberUsername = `mumem${stamp}`;
  const memberToken = await signupAndGetToken(
    memberCtx,
    `mu-mem-${stamp}@qufox.dev`,
    memberUsername,
  );

  const wsRes = await ownerCtx.request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'Mute E2E', slug: `mute-${stamp.toString(36)}` },
  });
  const workspace = (await wsRes.json()) as { id: string; slug: string };

  const inviteRes = await ownerCtx.request.post(`${API}/workspaces/${workspace.id}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const invite = (await inviteRes.json()) as { invite: { code: string } };
  await memberCtx.request.post(`${API}/invites/${invite.invite.code}/accept`, {
    headers: { authorization: `Bearer ${memberToken}`, origin: ORIGIN },
  });

  const generalRes = await ownerCtx.request.post(`${API}/workspaces/${workspace.id}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const general = (await generalRes.json()) as { id: string; name: string };

  const offtopicRes = await ownerCtx.request.post(`${API}/workspaces/${workspace.id}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'offtopic', type: 'TEXT' },
  });
  const offtopic = (await offtopicRes.json()) as { id: string; name: string };

  // Member mutes #general indefinitely (until = null).
  const muteRes = await memberCtx.request.post(`${API}/me/mutes/channels/${general.id}`, {
    headers: { authorization: `Bearer ${memberToken}`, origin: ORIGIN },
    data: {},
  });
  if (!muteRes.ok()) throw new Error(`mute failed: ${muteRes.status()} ${await muteRes.text()}`);

  const memberPage = await memberCtx.newPage();
  await loginInPage(memberPage, `mu-mem-${stamp}@qufox.dev`);
  await memberPage.goto(`/w/${workspace.slug}/${offtopic.name}`);
  await memberPage.waitForSelector('[data-testid=channel-general]');

  const generalRow = memberPage.locator('[data-testid=channel-general]');
  // Sanity: starts non-unread.
  await expect(generalRow).toHaveAttribute('data-unread', 'false');

  // Owner posts a plain (non-mention) message to the muted #general.
  await ownerCtx.request.post(`${API}/workspaces/${workspace.id}/channels/${general.id}/messages`, {
    headers: {
      authorization: `Bearer ${ownerToken}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: 'muted noise' },
  });

  // FR-RS-05: muted channel must NOT flip into unread. Give WS time to
  // arrive then assert the row stays non-unread.
  await memberPage.waitForTimeout(3_000);
  await expect(generalRow).toHaveAttribute('data-unread', 'false');

  // But a direct mention still surfaces the mention badge.
  await ownerCtx.request.post(`${API}/workspaces/${workspace.id}/channels/${general.id}/messages`, {
    headers: {
      authorization: `Bearer ${ownerToken}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: `@${memberUsername} you are pinged` },
  });
  const mentionBadge = memberPage.locator(
    '[data-testid=channel-general] [data-testid=unread-pill-mention].qf-badge--count',
  );
  await expect(mentionBadge).toBeVisible({ timeout: 10_000 });
  await expect(mentionBadge).toHaveText(/\d/);
  // The row itself stays unread-suppressed even with a mention pending.
  await expect(generalRow).toHaveAttribute('data-unread', 'false');

  await memberPage.close();
  await ownerCtx.close();
  await memberCtx.close();
});
