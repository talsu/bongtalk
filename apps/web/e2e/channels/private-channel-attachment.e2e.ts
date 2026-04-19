import { test, expect, type BrowserContext } from '@playwright/test';
import crypto from 'node:crypto';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

test.setTimeout(120_000);

async function signupAndToken(ctx: BrowserContext, email: string, username: string) {
  const r = await ctx.request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email, username, password: PW },
  });
  const body = (await r.json()) as { accessToken: string; user: { id: string } };
  return { accessToken: body.accessToken, userId: body.user.id };
}

/**
 * Task-012-E E2E. Cross-feature: private channel ACL gates attachment
 * download. A creates private channel + uploads image → B (non-member)
 * can't download → B added via override → can download → B removed →
 * 403 again.
 */
test('private channel attachment ACL: 403 → 200 → 403 across membership', async ({ browser }) => {
  const stamp = Date.now();
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();

  const a = await signupAndToken(aCtx, `pca-a-${stamp}@qufox.dev`, `pcaa${stamp}`);
  const b = await signupAndToken(bCtx, `pca-b-${stamp}@qufox.dev`, `pcab${stamp}`);

  const ws = await (
    await aCtx.request.post(`${API}/workspaces`, {
      headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
      data: { name: 'PCA', slug: `pca-${stamp.toString(36)}` },
    })
  ).json();
  const inv = await (
    await aCtx.request.post(`${API}/workspaces/${ws.id}/invites`, {
      headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
      data: { maxUses: 5 },
    })
  ).json();
  await bCtx.request.post(`${API}/invites/${inv.invite.code}/accept`, {
    headers: { authorization: `Bearer ${b.accessToken}`, origin: ORIGIN },
  });

  const ch = await (
    await aCtx.request.post(`${API}/workspaces/${ws.id}/channels`, {
      headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
      data: { name: 'vault', type: 'TEXT', isPrivate: true },
    })
  ).json();

  // A uploads a 1x1 PNG via presign → PUT → finalize.
  const pngBytes = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  );
  const presign = await (
    await aCtx.request.post(`${API}/attachments/presign-upload`, {
      headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
      data: {
        clientAttachmentId: crypto.randomUUID(),
        channelId: ch.id,
        mime: 'image/png',
        sizeBytes: pngBytes.length,
        originalName: 'vault.png',
      },
    })
  ).json();
  await aCtx.request.put(presign.putUrl, {
    headers: { 'content-type': 'image/png' },
    data: pngBytes,
  });
  await aCtx.request.post(`${API}/attachments/${presign.attachmentId}/finalize`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
  });

  // B (non-member of the private channel) tries to download. 403.
  const before = await bCtx.request.get(`${API}/attachments/${presign.attachmentId}/download-url`, {
    headers: { authorization: `Bearer ${b.accessToken}`, origin: ORIGIN },
  });
  expect(before.status()).toBe(403);

  // A adds B with READ permission (0x0001).
  await aCtx.request.post(`${API}/workspaces/${ws.id}/channels/${ch.id}/members`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
    data: { userId: b.userId, allowMask: 0x0001 },
  });

  // B retries. 200.
  const after = await bCtx.request.get(`${API}/attachments/${presign.attachmentId}/download-url`, {
    headers: { authorization: `Bearer ${b.accessToken}`, origin: ORIGIN },
  });
  expect(after.status()).toBe(200);

  // A overrides B to DENY READ (0x0001). DENY > ALLOW.
  await aCtx.request.post(`${API}/workspaces/${ws.id}/channels/${ch.id}/members`, {
    headers: { authorization: `Bearer ${a.accessToken}`, origin: ORIGIN },
    data: { userId: b.userId, allowMask: 0x0001, denyMask: 0x0001 },
  });
  const after2 = await bCtx.request.get(`${API}/attachments/${presign.attachmentId}/download-url`, {
    headers: { authorization: `Bearer ${b.accessToken}`, origin: ORIGIN },
  });
  expect(after2.status()).toBe(403);

  await aCtx.close();
  await bCtx.close();
});
