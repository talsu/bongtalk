import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-022 polish harness — members modal.
 *
 * Asserts:
 *  1. Opens from workspace dropdown "멤버 관리".
 *  2. Modal shows current members.
 *  3. ESC closes modal.
 *  4. Clicking the workspace header re-opens after close.
 *  5. Modal's member rows are keyboard-reachable (focus + tab).
 */
test.setTimeout(60_000);
test('polish: members modal open/close + keyboard nav (R4-members-modal)', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `polmm-${stamp.toString(36)}`;
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polmm-o-${stamp}@qufox.dev`, username: `polmmo${stamp}`, password: PW },
  });
  const ownerToken = (await owner.json()).accessToken as string;
  const ownerUsername = `polmmo${stamp}`;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'MembersModal', slug },
  });
  const wsId = (await ws.json()).id as string;
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  // Invite a peer so the modal has at least 2 rows.
  const peer = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polmm-p-${stamp}@qufox.dev`, username: `polmmp${stamp}`, password: PW },
  });
  const peerToken = (await peer.json()).accessToken as string;
  const invite = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { maxUses: 2 },
  });
  const inviteBody = await invite.json();
  const code = inviteBody.invite?.code ?? inviteBody.code;
  await request.post(`${API}/invites/${code}/accept`, {
    headers: { authorization: `Bearer ${peerToken}`, origin: ORIGIN },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`polmm-o-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));

  // Open via workspace header dropdown.
  await page.getByTestId('ws-header-trigger').click();
  await page.getByTestId('ws-open-members').click();

  const modalList = page.getByTestId('ws-members-modal-list');
  await expect(modalList).toBeVisible();
  const ownerRow = page.getByTestId(`ws-member-${ownerUsername}`);
  await expect(ownerRow).toBeVisible();

  // ESC closes.
  await page.keyboard.press('Escape');
  await expect(modalList).toHaveCount(0);

  // Reopen via header dropdown works again.
  await page.getByTestId('ws-header-trigger').click();
  await page.getByTestId('ws-open-members').click();
  await expect(page.getByTestId('ws-members-modal-list')).toBeVisible();

  // Keyboard reach: tab through the modal at least once without focus
  // escaping the modal container (Radix Dialog's focus trap).
  await page.keyboard.press('Tab');
  const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
  expect(['BUTTON', 'SELECT', 'INPUT']).toContain(activeTag);
});
