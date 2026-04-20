import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(90_000);
test('user can flip to DnD from the BottomBar profile menu (task-019-C)', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `dnd-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `dnd-${stamp}@qufox.dev`, username: `dnd${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'DnDWs', slug },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`dnd-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));

  const trigger = page.getByTestId('presence-status-trigger');
  await expect(trigger).toHaveAttribute('data-presence', 'online');

  await trigger.click();
  await page.getByTestId('presence-set-dnd').click();

  await expect(trigger).toHaveAttribute('data-presence', 'dnd');
  await expect(page.getByTestId('home-status')).toHaveText('방해 금지');
});

test('co-member sees the DnD status via presence.updated broadcast within 2s (task-019-C, reviewer HIGH)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `dndfan-${stamp.toString(36)}`;

  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: {
      email: `dndo-${stamp}@qufox.dev`,
      username: `dndo${stamp}`,
      password: PW,
    },
  });
  const ownerToken = (await owner.json()).accessToken as string;
  const ownerUsername = `dndo${stamp}`;

  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'DnDFan', slug },
  });
  const wsId = (await ws.json()).id as string;

  const peer = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: {
      email: `dndp-${stamp}@qufox.dev`,
      username: `dndp${stamp}`,
      password: PW,
    },
  });
  const peerToken = (await peer.json()).accessToken as string;
  const invite = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  const inviteBody = await invite.json();
  const code = inviteBody.invite?.code ?? inviteBody.code;
  await request.post(`${API}/invites/${code}/accept`, {
    headers: { authorization: `Bearer ${peerToken}`, origin: ORIGIN },
  });

  const ownerCtx = await browser.newContext();
  const ownerPage = await ownerCtx.newPage();
  await ownerPage.goto('/login');
  await ownerPage.getByTestId('login-email').fill(`dndo-${stamp}@qufox.dev`);
  await ownerPage.getByTestId('login-password').fill(PW);
  await ownerPage.getByTestId('login-submit').click();
  await expect(ownerPage).toHaveURL(new RegExp(`/w/${slug}`));

  const peerCtx = await browser.newContext();
  const peerPage = await peerCtx.newPage();
  await peerPage.goto('/login');
  await peerPage.getByTestId('login-email').fill(`dndp-${stamp}@qufox.dev`);
  await peerPage.getByTestId('login-password').fill(PW);
  await peerPage.getByTestId('login-submit').click();
  await expect(peerPage).toHaveURL(new RegExp(`/w/${slug}`));

  // Open the member column if closed.
  const membersToggle = peerPage.getByTestId('topbar-members-toggle');
  if (await membersToggle.count()) {
    const column = peerPage.getByTestId('member-column');
    if (!(await column.isVisible().catch(() => false))) await membersToggle.click();
  }

  // Owner flips to DnD.
  await ownerPage.getByTestId('presence-status-trigger').click();
  await ownerPage.getByTestId('presence-set-dnd').click();
  await expect(ownerPage.getByTestId('presence-status-trigger')).toHaveAttribute(
    'data-presence',
    'dnd',
  );

  // Peer's member row for owner should flip to data-presence=dnd via
  // the workspace-scoped presence.updated broadcast.
  const ownerMemberRow = peerPage.getByTestId(`member-${ownerUsername}`);
  await expect(ownerMemberRow).toHaveAttribute('data-presence', 'dnd', { timeout: 5000 });
});
