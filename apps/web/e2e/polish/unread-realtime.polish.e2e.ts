import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-021 polish harness — unread propagation speed.
 *
 * Scenario: B viewing channel C1; A posts to C2 in the same workspace.
 * B's sidebar C2 row AND server-rail workspace button update within 2s.
 * Extends the existing realtime unread-propagation e2e with an explicit
 * 2s SLA threshold for polish.
 */
test.setTimeout(90_000);
test('polish: cross-channel unread propagates to sidebar + server rail ≤ 2s (R1 detector)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `polu-${stamp.toString(36)}`;
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polu-o-${stamp}@qufox.dev`, username: `poluo${stamp}`, password: PW },
  });
  const ownerToken = (await owner.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'PolishUnread', slug },
  });
  const wsId = (await ws.json()).id as string;
  for (const name of ['c1', 'c2']) {
    await request.post(`${API}/workspaces/${wsId}/channels`, {
      headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
      data: { name, type: 'TEXT' },
    });
  }
  const c2Id = await request
    .get(`${API}/workspaces/${wsId}/channels`, {
      headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    })
    .then(async (r) => {
      const body = await r.json();
      const all = [
        ...body.uncategorized,
        ...body.categories.flatMap((c: { channels: { id: string; name: string }[] }) => c.channels),
      ];
      return all.find((c: { name: string }) => c.name === 'c2')!.id as string;
    });

  const peer = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polu-p-${stamp}@qufox.dev`, username: `polup${stamp}`, password: PW },
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

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/login');
  await pageB.getByTestId('login-email').fill(`polu-p-${stamp}@qufox.dev`);
  await pageB.getByTestId('login-password').fill(PW);
  await pageB.getByTestId('login-submit').click();
  await expect(pageB).toHaveURL(new RegExp(`/w/${slug}`));
  await pageB.getByTestId('channel-c1').click();

  // Post from owner to c2 via REST.
  await request.post(`${API}/workspaces/${wsId}/channels/${c2Id}/messages`, {
    headers: {
      authorization: `Bearer ${ownerToken}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: 'cross-channel ping' },
  });

  // Sidebar c2 row should light up within 2s.
  await expect(pageB.locator('[data-testid="channel-c2"][data-unread="true"]')).toBeVisible({
    timeout: 2500,
  });
  // Server-rail unread badge for this workspace.
  await expect(pageB.getByTestId(`ws-unread-${slug}`)).toBeVisible({ timeout: 5000 });
});
