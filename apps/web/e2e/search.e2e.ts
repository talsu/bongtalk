import { test, expect, type BrowserContext } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);

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

/**
 * Task-015-C: Ctrl+/ opens search → typed query returns results → click
 * navigates with ?msg=<id>. Also verifies private channel messages are
 * filtered out for a non-member.
 */
test('search overlay: type hello, see highlighted result, click → ?msg=', async ({ browser }) => {
  const stamp = Date.now();
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();

  const a = await signupAndToken(aCtx, `src-a-${stamp}@qufox.dev`, `srca${stamp}`);
  const b = await signupAndToken(bCtx, `src-b-${stamp}@qufox.dev`, `srcb${stamp}`);

  // Workspace + public channel + private channel + invite B.
  const wsRes = await aCtx.request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
    data: { name: 'Search E2E', slug: `src-${stamp.toString(36)}` },
  });
  const workspace = (await wsRes.json()) as { id: string; slug: string };

  const inv = await aCtx.request.post(`${API}/workspaces/${workspace.id}/invites`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const code = (await inv.json()).invite.code as string;
  await bCtx.request.post(`${API}/invites/${code}/accept`, {
    headers: { authorization: `Bearer ${b.accessToken}`, origin: ORIGIN },
  });

  const pub = await aCtx.request.post(`${API}/workspaces/${workspace.id}/channels`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const general = (await pub.json()) as { id: string; name: string };
  const priv = await aCtx.request.post(`${API}/workspaces/${workspace.id}/channels`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
    data: { name: 'leadership', type: 'TEXT', isPrivate: true },
  });
  const leadership = (await priv.json()) as { id: string; name: string };

  await aCtx.request.post(`${API}/workspaces/${workspace.id}/channels/${general.id}/messages`, {
    headers: {
      authorization: `Bearer ${a.accessToken}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: 'hello world from A' },
  });
  await aCtx.request.post(`${API}/workspaces/${workspace.id}/channels/${leadership.id}/messages`, {
    headers: {
      authorization: `Bearer ${a.accessToken}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: 'hello private secret' },
  });

  const bPage = await bCtx.newPage();
  await bPage.goto('/login');
  await bPage.fill('[data-testid=login-email]', `src-b-${stamp}@qufox.dev`);
  await bPage.fill('[data-testid=login-password]', PW);
  await bPage.click('[data-testid=login-submit]');
  await bPage.waitForURL(/\/w\//);
  await bPage.goto(`/w/${workspace.slug}/${general.name}`);

  // Ctrl+/ focuses the inline topbar search + opens the result
  // dropdown once the 300ms debounce elapses.
  await bPage.keyboard.press('Control+/');
  await expect(bPage.getByTestId('topbar-search')).toBeFocused();
  await bPage.getByTestId('topbar-search').fill('hello');

  // Wait past the 300ms debounce.
  await bPage.waitForTimeout(450);
  await expect(bPage.getByTestId('search-results')).toBeVisible({ timeout: 5_000 });
  const pubResult = bPage.locator(`[data-testid^=search-result-]`).first();
  await expect(pubResult).toBeVisible();
  // Snippet must have the mark tag + NOT expose the private channel.
  const snippetHtml = await pubResult.locator('p').innerHTML();
  expect(snippetHtml).toContain('<mark>hello</mark>');

  // All results must be from #general; #leadership is private + B is not a member.
  const rows = bPage.locator(`[data-testid^=search-result-]`);
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < count; i++) {
    const block = rows.nth(i);
    await expect(block).toContainText(`# ${general.name}`);
  }

  // Click → navigates with ?msg= and collapses the dropdown. The
  // topbar input itself stays mounted (it lives in the chat chrome),
  // only the results dropdown goes away.
  await pubResult.click();
  await bPage.waitForURL(/\?msg=/);
  expect(bPage.url()).toContain(`/w/${workspace.slug}/${general.name}`);
  expect(bPage.url()).toContain('?msg=');
  await expect(bPage.getByTestId('search-dropdown')).toHaveCount(0);

  await bPage.close();
  await aCtx.close();
  await bCtx.close();
});
