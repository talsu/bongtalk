import { test, expect, type BrowserContext } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(120_000);

async function signupAndToken(ctx: BrowserContext, email: string, username: string) {
  const r = await ctx.request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username, password: PW },
  });
  const body = (await r.json()) as { accessToken: string; user: { id: string } };
  return { accessToken: body.accessToken, userId: body.user.id };
}

/**
 * Task-012-D E2E. Private channel visibility + add-member flow.
 * OWNER creates a private channel, second member can't see it in
 * listByWorkspace, OWNER adds them via POST /channels/:chid/members
 * with READ|WRITE_MESSAGE allow mask, they see it.
 */
test('private channel: hidden until override, visible after', async ({ browser }) => {
  const stamp = Date.now();
  const ownerCtx = await browser.newContext();
  const memberCtx = await browser.newContext();

  const owner = await signupAndToken(ownerCtx, `pch-own-${stamp}@qufox.dev`, `pchown${stamp}`);
  const member = await signupAndToken(memberCtx, `pch-mem-${stamp}@qufox.dev`, `pchmem${stamp}`);

  const ws = await (
    await ownerCtx.request.post(`${API}/workspaces`, {
      headers: { authorization: `Bearer ${owner.accessToken}`, origin: ORIGIN },
      data: { name: 'PCH', slug: `pch-${stamp.toString(36)}` },
    })
  ).json();

  const inv = await (
    await ownerCtx.request.post(`${API}/workspaces/${ws.id}/invites`, {
      headers: { authorization: `Bearer ${owner.accessToken}`, origin: ORIGIN },
      data: { maxUses: 5 },
    })
  ).json();
  await memberCtx.request.post(`${API}/invites/${inv.invite.code}/accept`, {
    headers: { authorization: `Bearer ${member.accessToken}`, origin: ORIGIN },
  });

  // Owner creates a private channel (isPrivate:true at create time).
  const privateChRes = await ownerCtx.request.post(`${API}/workspaces/${ws.id}/channels`, {
    headers: { authorization: `Bearer ${owner.accessToken}`, origin: ORIGIN },
    data: { name: 'secret', type: 'TEXT', isPrivate: true },
  });
  expect(privateChRes.ok()).toBe(true);
  const privateCh = await privateChRes.json();

  // Member lists channels — secret is NOT present.
  const listBefore = await (
    await memberCtx.request.get(`${API}/workspaces/${ws.id}/channels`, {
      headers: { authorization: `Bearer ${member.accessToken}`, origin: ORIGIN },
    })
  ).json();
  const flatBefore = [
    ...listBefore.uncategorized,
    ...listBefore.categories.flatMap((c: { channels: unknown[] }) => c.channels),
  ];
  expect(flatBefore.some((c: { name: string }) => c.name === 'secret')).toBe(false);

  // Owner grants READ|WRITE_MESSAGE (0x0001 | 0x0002 = 0x0003) to member.
  const grant = await ownerCtx.request.post(
    `${API}/workspaces/${ws.id}/channels/${privateCh.id}/members`,
    {
      headers: { authorization: `Bearer ${owner.accessToken}`, origin: ORIGIN },
      data: { userId: member.userId, allowMask: 0x0003 },
    },
  );
  expect(grant.ok()).toBe(true);

  // Member lists again — secret is now present.
  const listAfter = await (
    await memberCtx.request.get(`${API}/workspaces/${ws.id}/channels`, {
      headers: { authorization: `Bearer ${member.accessToken}`, origin: ORIGIN },
    })
  ).json();
  const flatAfter = [
    ...listAfter.uncategorized,
    ...listAfter.categories.flatMap((c: { channels: unknown[] }) => c.channels),
  ];
  expect(flatAfter.some((c: { name: string }) => c.name === 'secret')).toBe(true);

  await ownerCtx.close();
  await memberCtx.close();
});
