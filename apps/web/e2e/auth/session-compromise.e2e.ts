import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';

test('replay of an already-rotated refresh token burns the session', async ({ page, context, request }) => {
  const stamp = Date.now();
  const email = `evil-${stamp}@qufox.dev`;
  const username = `evil${stamp}`;

  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-username').fill(username);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(username);

  const cookies = await context.cookies();
  const stolen = cookies.find((c) => c.name === 'refresh_token');
  if (!stolen) throw new Error('no refresh cookie present');

  // Victim legitimately refreshes → stolen token becomes revoked.
  const api = process.env.VITE_API_URL ?? 'http://localhost:43001';
  const first = await request.post(`${api}/auth/refresh`, {
    headers: { cookie: `refresh_token=${stolen.value}`, origin: 'http://localhost:45173' },
  });
  expect(first.status()).toBe(200);

  // Attacker replays the old cookie — must be rejected as compromised.
  const replay = await request.post(`${api}/auth/refresh`, {
    headers: { cookie: `refresh_token=${stolen.value}`, origin: 'http://localhost:45173' },
  });
  expect(replay.status()).toBe(401);
  const body = await replay.json();
  expect(body.errorCode).toBe('AUTH_SESSION_COMPROMISED');
});
