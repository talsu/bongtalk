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
 * Task-010-B E2E:
 *  - owner posts a message in #general from context A;
 *  - member (in context B, viewing a different channel) sees the unread
 *    dot/pill bump in the sidebar;
 *  - member navigates into #general; the dot disappears (POST /read);
 *  - mention variant asserts the mention-coloured dot appears.
 */
test('unread dot bumps on realtime message and clears on channel open', async ({ browser }) => {
  const stamp = Date.now();
  const ownerCtx = await browser.newContext();
  const memberCtx = await browser.newContext();

  const ownerToken = await signupAndGetToken(
    ownerCtx,
    `ur-own-${stamp}@qufox.dev`,
    `urown${stamp}`,
  );
  const memberToken = await signupAndGetToken(
    memberCtx,
    `ur-mem-${stamp}@qufox.dev`,
    `urmem${stamp}`,
  );

  const wsRes = await ownerCtx.request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'Unread E2E', slug: `unread-${stamp.toString(36)}` },
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

  const memberPage = await memberCtx.newPage();
  await loginInPage(memberPage, `ur-mem-${stamp}@qufox.dev`);
  // Member opens #offtopic so #general is NOT active when the broadcast
  // lands — the dispatcher's unread bump should fire.
  await memberPage.goto(`/w/${workspace.slug}/${offtopic.name}`);
  await memberPage.waitForSelector('[data-testid=channel-general]');

  // Owner posts to #general.
  await ownerCtx.request.post(`${API}/workspaces/${workspace.id}/channels/${general.id}/messages`, {
    headers: {
      authorization: `Bearer ${ownerToken}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: 'hey everyone', mentions: { users: [], channels: [], everyone: false } },
  });

  // Member's sidebar should flip #general into unread. Give the
  // WS propagation up to 10s.
  const unreadDot = memberPage.locator('[data-testid=channel-general] [data-testid^=unread-dot]');
  await expect(unreadDot).toBeVisible({ timeout: 10_000 });

  // Opening #general clears the unread.
  await memberPage.goto(`/w/${workspace.slug}/${general.name}`);
  await expect(unreadDot).toBeHidden({ timeout: 5_000 });

  // Mention variant: owner @mentions the member while the member is
  // looking at #offtopic.
  await memberPage.goto(`/w/${workspace.slug}/${offtopic.name}`);
  await memberPage.waitForSelector('[data-testid=channel-general]');
  await ownerCtx.request.post(`${API}/workspaces/${workspace.id}/channels/${general.id}/messages`, {
    headers: {
      authorization: `Bearer ${ownerToken}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: {
      content: `@urmem${stamp} ping`,
      mentions: {
        users: [
          /* member id not resolved on the client, server doesn't echo yet */
        ],
        channels: [],
        everyone: true,
      },
    },
  });
  const mentionDot = memberPage.locator(
    '[data-testid=channel-general] [data-testid=unread-dot-mention]',
  );
  await expect(mentionDot).toBeVisible({ timeout: 10_000 });

  await memberPage.close();
  await ownerCtx.close();
  await memberCtx.close();
});
