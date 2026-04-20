import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-021 polish harness — presence timing.
 *
 * Scenario: A force-closes; B's member row flips offline. Session TTL
 * is 120s (task-005); if the polish target is "offline within 5s"
 * that requires a tighter signal (heartbeat + close-detection) than
 * the pure TTL path. Harness documents the CURRENT window (TTL-bound)
 * so a future fix — e.g. a shorter session TTL for beta, or explicit
 * client-side presence.disconnect emit — can tighten it.
 */
test.setTimeout(180_000);
test('polish: presence offline flips after force-close within presence session TTL (R1 detector)', async ({
  browser,
  request,
}) => {
  const stamp = Date.now();
  const slug = `polp-${stamp.toString(36)}`;
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polp-o-${stamp}@qufox.dev`, username: `polpo${stamp}`, password: PW },
  });
  const ownerToken = (await owner.json()).accessToken as string;
  const ownerUsername = `polpo${stamp}`;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'PolishPresence', slug },
  });
  const wsId = (await ws.json()).id as string;
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const peer = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polp-p-${stamp}@qufox.dev`, username: `polpp${stamp}`, password: PW },
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

  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto('/login');
  await pageA.getByTestId('login-email').fill(`polp-o-${stamp}@qufox.dev`);
  await pageA.getByTestId('login-password').fill(PW);
  await pageA.getByTestId('login-submit').click();
  await expect(pageA).toHaveURL(new RegExp(`/w/${slug}`));

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/login');
  await pageB.getByTestId('login-email').fill(`polp-p-${stamp}@qufox.dev`);
  await pageB.getByTestId('login-password').fill(PW);
  await pageB.getByTestId('login-submit').click();
  await expect(pageB).toHaveURL(new RegExp(`/w/${slug}`));
  await pageB.getByTestId('channel-general').click();

  const row = pageB.getByTestId(`member-${ownerUsername}`);
  await expect(row).toHaveAttribute('data-presence', 'online', { timeout: 5000 });

  await ctxA.close();

  // The 018-F disconnect hook runs immediately on WS close; presence
  // broadcast is throttled to 2s. Expect offline within ~5s under
  // normal conditions (not the full 120s TTL).
  await expect(row).toHaveAttribute('data-presence', 'offline', { timeout: 10_000 });
});
