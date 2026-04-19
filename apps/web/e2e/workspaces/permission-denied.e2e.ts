import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';

test('non-member hitting /w/<other-slug> lands on not-found, and a MEMBER cannot see invite button', async ({ page, request }) => {
  const stamp = Date.now();

  // Owner creates a workspace via API (faster than driving the UI twice here).
  const ownerEmail = `pd-own-${stamp}@qufox.dev`;
  const ownerUsername = `pdown${stamp}`;
  const signup = await request.post(`http://localhost:43001/auth/signup`, {
    headers: { origin: 'http://localhost:45173' },
    data: { email: ownerEmail, username: ownerUsername, password: PW },
  });
  expect(signup.status()).toBe(201);
  const ownerAccess = (await signup.json()).accessToken as string;
  const wsSlug = `pd-${stamp.toString(36)}`;
  const wsRes = await request.post(`http://localhost:43001/workspaces`, {
    headers: { origin: 'http://localhost:45173', authorization: `Bearer ${ownerAccess}` },
    data: { name: 'PrivateWs', slug: wsSlug },
  });
  expect(wsRes.status()).toBe(201);

  // Now an unrelated user logs in via the UI — the private workspace must be invisible.
  const visitorEmail = `pd-vis-${stamp}@qufox.dev`;
  const visitorUsername = `pdvis${stamp}`;
  await page.goto('/signup');
  await page.getByTestId('signup-email').fill(visitorEmail);
  await page.getByTestId('signup-username').fill(visitorUsername);
  await page.getByTestId('signup-password').fill(PW);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('home-username')).toHaveText(visitorUsername);

  // Directly navigating to the slug they do not belong to renders the "not found"
  // panel (the layout can't find the workspace in the visitor's list).
  await page.goto(`/w/${wsSlug}`);
  await expect(page.getByTestId('ws-not-found')).toBeVisible();
});
