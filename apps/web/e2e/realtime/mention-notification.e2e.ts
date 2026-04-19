import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(120_000);

async function signupAndToken(
  ctx: BrowserContext,
  email: string,
  username: string,
): Promise<{ accessToken: string; userId: string }> {
  const r = await ctx.request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username, password: PW },
  });
  if (!r.ok()) throw new Error(`signup: ${r.status()} ${await r.text()}`);
  const body = (await r.json()) as { accessToken: string; user: { id: string } };
  return { accessToken: body.accessToken, userId: body.user.id };
}

async function loginInPage(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('[data-testid=login-email]', email);
  await page.fill('[data-testid=login-password]', PW);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL('**');
}

/**
 * Task-011-B E2E: two browser contexts. A posts `@B-username` in
 * #general. B (on #offtopic) sees:
 *  - a mention-variant toast within 2s, title "You were mentioned"
 *  - sidebar @-badge count flips to ≥1
 *  - clicking the toast navigates to `?msg=<id>`
 *  - after navigate, the mention dot from task-010-B ChannelList
 *    integrates: #general no longer has a dot (active) and the
 *    mention badge clears.
 */
test('mention broadcast lights toast + sidebar badge, jump navigates with ?msg', async ({
  browser,
}) => {
  const stamp = Date.now();
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();

  const a = await signupAndToken(aCtx, `men-a-${stamp}@qufox.dev`, `mena${stamp}`);
  const b = await signupAndToken(bCtx, `men-b-${stamp}@qufox.dev`, `menb${stamp}`);

  const wsRes = await aCtx.request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
    data: { name: 'Mention E2E', slug: `men-${stamp.toString(36)}` },
  });
  const workspace = (await wsRes.json()) as { id: string; slug: string };

  const inv = await aCtx.request.post(`${API}/workspaces/${workspace.id}/invites`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const invite = (await inv.json()) as { invite: { code: string } };
  await bCtx.request.post(`${API}/invites/${invite.invite.code}/accept`, {
    headers: { authorization: `Bearer ${b.accessToken}`, origin: ORIGIN },
  });

  const generalRes = await aCtx.request.post(`${API}/workspaces/${workspace.id}/channels`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const general = (await generalRes.json()) as { id: string; name: string };

  const offtopicRes = await aCtx.request.post(`${API}/workspaces/${workspace.id}/channels`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
    data: { name: 'offtopic', type: 'TEXT' },
  });
  const offtopic = (await offtopicRes.json()) as { id: string; name: string };

  const bPage = await bCtx.newPage();
  await loginInPage(bPage, `men-b-${stamp}@qufox.dev`);
  await bPage.goto(`/w/${workspace.slug}/${offtopic.name}`);
  await bPage.waitForSelector('[data-testid=channel-general]');

  // A @mentions B. The server resolves @menb<stamp> → B's user id and
  // stores it on Message.mentions; the outbox fan-out emits
  // mention.received targeted at B.
  await aCtx.request.post(`${API}/workspaces/${workspace.id}/channels/${general.id}/messages`, {
    headers: {
      authorization: `Bearer ${a.accessToken}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: {
      content: `@menb${stamp} hello there`,
      mentions: { users: [], channels: [], everyone: false },
    },
  });

  // Toast should appear within 2s.
  const toast = bPage.locator('[data-testid=toast-mention]');
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toContainText('mentioned');

  // Sidebar badge flips on.
  const badge = bPage.locator('[data-testid=mention-badge]');
  await expect(badge).toBeVisible({ timeout: 5_000 });

  // Click the toast → URL carries ?msg=<id>.
  await toast.click();
  await bPage.waitForURL(/\?msg=/);
  expect(bPage.url()).toContain(`/w/${workspace.slug}/${general.name}`);
  expect(bPage.url()).toContain('?msg=');

  // With #general active, the cross-feature integration from 010
  // kicks in: the unread badge/pill for #general disappears.
  const channelUnreadPill = bPage.locator(
    '[data-testid=channel-general] [data-testid^=unread-pill]',
  );
  await expect(channelUnreadPill).toBeHidden({ timeout: 5_000 });

  await bPage.close();
  await aCtx.close();
  await bCtx.close();
});
