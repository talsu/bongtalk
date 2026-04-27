import type { APIRequestContext, Page } from '@playwright/test';

export const PW = 'Quanta-Beetle-Nebula-42!';
export const API = 'http://localhost:43001';
export const ORIGIN = 'http://localhost:45173';

export const MOBILE_VIEWPORT = { width: 375, height: 667 } as const; // iPhone SE
export const MOBILE_VIEWPORT_PRO = { width: 390, height: 844 } as const; // iPhone 13/14
// task-040 R5: pixel-class viewport for the wider mobile band (iPhone XR / Plus).
export const MOBILE_VIEWPORT_XR = { width: 414, height: 896 } as const; // iPhone XR / 11
export const MOBILE_VIEWPORTS = [MOBILE_VIEWPORT, MOBILE_VIEWPORT_PRO, MOBILE_VIEWPORT_XR] as const;

export async function signupToken(
  request: APIRequestContext,
  email: string,
  username: string,
): Promise<string> {
  const r = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username, password: PW },
  });
  if (!r.ok()) throw new Error(`signup failed: ${r.status()} ${await r.text()}`);
  return ((await r.json()) as { accessToken: string }).accessToken;
}

export async function bootstrapWorkspace(
  request: APIRequestContext,
  token: string,
  opts: { name: string; slug: string; channels: string[] },
): Promise<{ workspaceId: string; channelIds: Record<string, string> }> {
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: opts.name, slug: opts.slug },
  });
  const wsId = ((await ws.json()) as { id: string }).id;
  const channelIds: Record<string, string> = {};
  for (const name of opts.channels) {
    const c = await request.post(`${API}/workspaces/${wsId}/channels`, {
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      data: { name, type: 'TEXT' },
    });
    channelIds[name] = ((await c.json()) as { id: string }).id;
  }
  return { workspaceId: wsId, channelIds };
}

export async function loginUI(page: Page, email: string, expectedSlug: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(new RegExp(`/w/${expectedSlug}`));
}
