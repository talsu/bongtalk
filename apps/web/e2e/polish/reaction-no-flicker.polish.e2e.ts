import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-021 polish harness — reaction flicker on own toggle.
 *
 * Scenario: user clicks 🦊 → optimistic `qf-reaction--me` pill appears
 * → WS echo arrives. The pill must stay continuously visible; no
 * off / on transition between optimistic and authoritative paths.
 *
 * Assertion strategy: poll the pill's getAttribute('class') in a tight
 * loop for 2 seconds starting at click, require it to be always
 * either absent (pre-click) or present-with--me (post-click); no
 * sampled state should be "present without --me".
 */
test.setTimeout(60_000);
test('polish: own reaction pill does not flicker between optimistic + WS echo (R1 detector)', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `polr-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polr-${stamp}@qufox.dev`, username: `polr${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'PolishReact', slug },
  });
  const wsId = (await ws.json()).id as string;
  const ch = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const chId = (await ch.json()).id as string;
  const m = await request.post(`${API}/workspaces/${wsId}/channels/${chId}/messages`, {
    headers: {
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      'idempotency-key': crypto.randomUUID(),
    },
    data: { content: 'react to me' },
  });
  const msgId = (await m.json()).id as string;

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`polr-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
  await page.getByTestId('channel-general').click();

  const addBtn = page.getByTestId(`msg-${msgId}`).getByTestId('reaction-add-btn');
  await addBtn.click();
  // Click quick-pick 🦊 (🦊 is not in QUICK_EMOJIS; use 👍 which is).
  await page.getByTestId('reaction-pick-👍').click();

  // Poll for 2s; assert no sample shows the pill PRESENT without --me.
  const samples: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const loc = page.getByTestId('reaction-👍');
    const count = await loc.count();
    if (count > 0) {
      const cls = (await loc.first().getAttribute('class')) ?? '';
      samples.push(cls);
    }
    await page.waitForTimeout(50);
  }
  const badSamples = samples.filter((c) => !c.includes('qf-reaction--me'));
  expect(badSamples).toHaveLength(0);
});
