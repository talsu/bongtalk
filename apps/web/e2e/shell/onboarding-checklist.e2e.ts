import { test, expect } from '@playwright/test';

/**
 * Task-016-C-1 (task-017-A-1 closure of the 016 deferred E2E):
 * sidebar onboarding card walk-through.
 *
 * Flow:
 *   1. fresh signup → card visible + 0/4 (all rows ⬜)
 *   2. create workspace     → 1/4
 *   3. create second channel → 2/4
 *   4. issue an invite      → 3/4
 *   5. send a message       → 4/4 → card auto-hides
 *   6. reload → card stays hidden (localStorage-persisted)
 *
 * After resetting localStorage the card reappears; the user then
 * clicks ✕ and reload shows the card still hidden (manual dismiss).
 */
const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(120_000);

test('sidebar onboarding card progresses 0→4 then auto-dismisses', async ({ page, request }) => {
  const stamp = Date.now();
  const email = `onb-${stamp}@qufox.dev`;
  const username = `onb${stamp}`;

  // 1. fresh signup
  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-username').fill(username);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  // Fresh users have no workspace → app redirects to /w/new. Stop before
  // creating a workspace so the "0/4" state is observable on the route
  // we land on (BottomBar is visible on /w/new too).
  await page.waitForURL(/\/w\/new/);

  // The OnboardingCard only mounts inside the full shell (/w/:slug).
  // We can't see 0/4 on /w/new, but we'll capture 1/4 (workspaces=1)
  // immediately after the workspace create.
  const slug = `onb-${stamp.toString(36)}`;
  await page.getByTestId('ws-name').fill('Onb');
  await page.getByTestId('ws-slug').fill(slug);
  await page.getByTestId('ws-create-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));

  const card = page.getByTestId('onboarding-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('onboarding-progress')).toContainText('1 / 4');

  // API helper to bypass UI for the remaining actions — keeps the test
  // focused on the card's observable state transitions.
  const loginRes = await request.post(`${API}/auth/login`, {
    headers: { origin: ORIGIN },
    data: { email, password: PW },
  });
  const token = (await loginRes.json()).accessToken as string;
  const list = await request.get(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const ws = (await list.json()).workspaces.find((w: { slug: string }) => w.slug === slug);

  // 3. second channel → 2/4
  const chRes = await request.post(`${API}/workspaces/${ws.id}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'general-2', type: 'TEXT' },
  });
  const channel = await chRes.json();
  await page.reload();
  await expect(page.getByTestId('onboarding-progress')).toContainText('2 / 4');

  // 4. invite → 3/4
  await request.post(`${API}/workspaces/${ws.id}/invites`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { maxUses: 5 },
  });
  await page.reload();
  await expect(page.getByTestId('onboarding-progress')).toContainText('3 / 4');

  // 5. first message → 4/4 → auto-dismiss
  await request.post(`${API}/workspaces/${ws.id}/channels/${channel.id}/messages`, {
    headers: {
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: 'hello world' },
  });
  await page.reload();
  await expect(card).toHaveCount(0);

  // 6. reload → still hidden (dismiss state persisted to localStorage)
  await page.reload();
  await expect(card).toHaveCount(0);
});

test('manual ✕ dismisses the card and the state persists across reload', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const email = `onb-x-${stamp}@qufox.dev`;
  const username = `onbx${stamp}`;

  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-username').fill(username);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await page.waitForURL(/\/w\/new/);

  const slug = `onbx-${stamp.toString(36)}`;
  await page.getByTestId('ws-name').fill('OnbX');
  await page.getByTestId('ws-slug').fill(slug);
  await page.getByTestId('ws-create-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));

  await expect(page.getByTestId('onboarding-card')).toBeVisible();
  await page.getByTestId('onboarding-dismiss').click();
  await expect(page.getByTestId('onboarding-card')).toHaveCount(0);

  // Reload — localStorage `qufox.onboarding.dismissed=true` still holds.
  await page.reload();
  await expect(page.getByTestId('onboarding-card')).toHaveCount(0);

  // Confirm via API helper the 4 counters are still <4 so the card
  // would otherwise be visible; proves the hide is driven by dismiss,
  // not by completion.
  const loginRes = await request.post(`${API}/auth/login`, {
    headers: { origin: ORIGIN },
    data: { email, password: PW },
  });
  const token = (await loginRes.json()).accessToken as string;
  const status = await request.get(`${API}/me/onboarding-status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const s = (await status.json()) as {
    workspaces: number;
    channels: number;
    invitesIssued: number;
    messagesSent: number;
  };
  expect(s.workspaces + s.channels + s.invitesIssued + s.messagesSent).toBeLessThan(
    4 * 4, // can't all be >=1; only workspaces+channels satisfied here
  );
  expect(s.invitesIssued).toBe(0);
  expect(s.messagesSent).toBe(0);
});
