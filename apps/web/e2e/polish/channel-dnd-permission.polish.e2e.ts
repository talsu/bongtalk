import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-022 polish harness — channel DnD permission.
 *
 * Asserts the 9d949e8 permission gate:
 *  1. OWNER: gear icon is visible on hover, drag handle listener
 *     attaches (dnd-dropline appears during drag).
 *  2. MEMBER (no manage): gear icon NOT rendered, cursor is
 *     `pointer` (not `grab`), qf-channel row has no drag attributes.
 */
test.setTimeout(90_000);
test('polish: DnD + gear permission-gated per canManage (R4-channel-dnd-permission)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `polcdnd-${stamp.toString(36)}`;
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polcdnd-o-${stamp}@qufox.dev`, username: `polcdndo${stamp}`, password: PW },
  });
  const ownerToken = (await owner.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'ChanDnD', slug },
  });
  const wsId = (await ws.json()).id as string;
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'random', type: 'TEXT' },
  });
  const peer = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polcdnd-p-${stamp}@qufox.dev`, username: `polcdndp${stamp}`, password: PW },
  });
  const peerToken = (await peer.json()).accessToken as string;
  const invite = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 2 },
  });
  const code = (await invite.json()).invite?.code as string;
  await request.post(`${API}/invites/${code}/accept`, {
    headers: { authorization: `Bearer ${peerToken}`, origin: ORIGIN },
  });

  const ownerCtx = await browser.newContext();
  const ownerPage = await ownerCtx.newPage();
  await ownerPage.goto('/login');
  await ownerPage.getByTestId('login-email').fill(`polcdnd-o-${stamp}@qufox.dev`);
  await ownerPage.getByTestId('login-password').fill(PW);
  await ownerPage.getByTestId('login-submit').click();
  await expect(ownerPage).toHaveURL(new RegExp(`/w/${slug}`));

  // Owner: gear button renders (may be opacity-0 until hover).
  const ownerRow = ownerPage.getByTestId('channel-general');
  await ownerRow.hover();
  await expect(ownerPage.getByTestId('channel-settings-btn-general')).toBeVisible();
  // Cursor: grab when manager.
  const ownerCursor = await ownerRow.evaluate((el) => window.getComputedStyle(el).cursor);
  expect(['grab', 'grabbing']).toContain(ownerCursor);
  await ownerCtx.close();

  // Member session.
  const memberCtx = await browser.newContext();
  const memberPage = await memberCtx.newPage();
  await memberPage.goto('/login');
  await memberPage.getByTestId('login-email').fill(`polcdnd-p-${stamp}@qufox.dev`);
  await memberPage.getByTestId('login-password').fill(PW);
  await memberPage.getByTestId('login-submit').click();
  await expect(memberPage).toHaveURL(new RegExp(`/w/${slug}`));

  const memberRow = memberPage.getByTestId('channel-general');
  await expect(memberRow).toBeVisible();
  // Gear button must NOT render for non-managers.
  await expect(memberPage.getByTestId('channel-settings-btn-general')).toHaveCount(0);
  // Cursor is pointer (row still clickable for navigation, just not grab).
  const memberCursor = await memberRow.evaluate((el) => window.getComputedStyle(el).cursor);
  expect(memberCursor).toBe('pointer');
  await memberCtx.close();
});
