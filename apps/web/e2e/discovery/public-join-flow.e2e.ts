import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(60_000);

test('POST /workspaces/:id/join is idempotent + PRIVATE rejected 403', async ({ request }) => {
  const stamp = Date.now();
  const owner = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `pj-o-${stamp}@qufox.dev`, username: `pjo${stamp}`, password: PW },
  });
  const ownerToken = ((await owner.json()) as { accessToken: string }).accessToken;
  const visitor = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `pj-v-${stamp}@qufox.dev`, username: `pjv${stamp}`, password: PW },
  });
  const visitorToken = ((await visitor.json()) as { accessToken: string }).accessToken;

  // Public workspace
  const pub = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: {
      name: 'JoinPub',
      slug: `jp-${stamp.toString(36)}`,
      visibility: 'PUBLIC',
      category: 'OTHER',
      description: 'join test',
    },
  });
  const pubBody = (await pub.json()) as { id: string };

  const join1 = await request.post(`${API}/workspaces/${pubBody.id}/join`, {
    headers: { authorization: `Bearer ${visitorToken}`, origin: ORIGIN },
  });
  expect(join1.ok()).toBeTruthy();
  const join1Body = (await join1.json()) as { alreadyMember: boolean };
  expect(join1Body.alreadyMember).toBe(false);

  const join2 = await request.post(`${API}/workspaces/${pubBody.id}/join`, {
    headers: { authorization: `Bearer ${visitorToken}`, origin: ORIGIN },
  });
  expect(join2.ok()).toBeTruthy();
  const join2Body = (await join2.json()) as { alreadyMember: boolean };
  expect(join2Body.alreadyMember).toBe(true);

  // Private workspace → join 403
  const priv = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${ownerToken}`, origin: ORIGIN },
    data: { name: 'PrivNo', slug: `pn-${stamp.toString(36)}` },
  });
  const privBody = (await priv.json()) as { id: string };
  const join3 = await request.post(`${API}/workspaces/${privBody.id}/join`, {
    headers: { authorization: `Bearer ${visitorToken}`, origin: ORIGIN },
  });
  expect(join3.status()).toBe(403);
  const err = await join3.json();
  expect(err.errorCode).toBe('WORKSPACE_NOT_PUBLIC');
});
