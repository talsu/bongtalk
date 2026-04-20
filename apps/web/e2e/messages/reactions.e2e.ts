import { test, expect } from '@playwright/test';

/**
 * Task-013-B: reaction happy path — post a message, open the picker,
 * pick 👍, see the pill mount with count=1 / byMe true. Click it again
 * to toggle off.
 */

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);
test('add → see bucket → toggle off round-trips through the server', async ({ page, request }) => {
  const stamp = Date.now();
  const slug = `rx-${stamp.toString(36)}`;
  const email = `rx-${stamp}@qufox.dev`;
  const username = `rx${stamp}`;

  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-username').fill(username);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(username);

  await page.goto('/w/new');
  await page.getByTestId('ws-name').fill('Reactions');
  await page.getByTestId('ws-slug').fill(slug);
  await page.getByTestId('ws-create-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`));

  // Use the API for deterministic workspace/channel creation.
  const loginRes = await request.post(`${API}/auth/login`, {
    headers: { origin: ORIGIN },
    data: { email, password: PW },
  });
  const token = (await loginRes.json()).accessToken as string;
  const list = await request.get(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const ws = (await list.json()).workspaces.find((w: { slug: string }) => w.slug === slug);
  const chRes = await request.post(`${API}/workspaces/${ws.id}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: `rx-${stamp.toString(36).slice(-5)}`, type: 'TEXT' },
  });
  const channelName: string = (await chRes.json()).name;

  await page.goto(`/w/${slug}/${channelName}`);
  await page.getByTestId('msg-input').fill('react to me');
  await page.getByTestId('msg-send').click();
  const mine = page.getByText('react to me').first();
  await expect(mine).toBeVisible();

  // Derive the persisted msg-id so we target testids on the right row.
  const msgTestid = await mine
    .locator('xpath=ancestor::*[starts-with(@data-testid, "msg-")]')
    .getAttribute('data-testid');
  const idPart = msgTestid!.replace(/^msg-/, '');
  // tempId starts with `tmp-` — the WS roundtrip replaces it. Wait for the
  // real id before clicking the reaction button so our mutation targets
  // the persisted row (ReactionBar no-ops on tmp-* ids).
  expect(idPart.startsWith('tmp-')).toBeFalsy();

  // Hover the message so the reaction + button fades in, then open picker.
  await page.getByTestId(`msg-${idPart}`).hover();
  await page.getByTestId('reaction-add-btn').first().click();
  await page.getByTestId('reaction-pick-👍').click();

  // Pill appears with count=1 + aria-pressed=true (byMe).
  const pill = page.getByTestId('reaction-👍');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect(pill).toHaveAttribute('aria-label', /👍 1/);

  // Toggle off — the pill should disappear once the server echoes count=0.
  await pill.click();
  await expect(page.getByTestId('reaction-👍')).toHaveCount(0);
});
