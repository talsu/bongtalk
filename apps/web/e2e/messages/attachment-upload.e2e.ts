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
  if (!r.ok()) throw new Error(`signup: ${r.status()} ${await r.text()}`);
  const body = (await r.json()) as { accessToken: string; user: { id: string } };
  return { accessToken: body.accessToken, userId: body.user.id };
}

/**
 * Task-012-C E2E. Drives the presign → PUT → finalize round-trip
 * against the test-api + test-minio stack, then asserts the message
 * renders with an image preview. Runs on GitHub Actions via
 * docker-compose.test.yml (task-011-D); on the NAS the MinIO service
 * isn't in the test compose so this test is GHA-only.
 */
test('attachment: presign → PUT → finalize → image renders', async ({ browser }) => {
  const stamp = Date.now();
  const ctx = await browser.newContext();
  const { accessToken } = await signupAndToken(ctx, `att-${stamp}@qufox.dev`, `att${stamp}`);

  const wsRes = await ctx.request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${accessToken}`, origin: ORIGIN },
    data: { name: 'Att E2E', slug: `att-${stamp.toString(36)}` },
  });
  const workspace = (await wsRes.json()) as { id: string; slug: string };

  const chRes = await ctx.request.post(`${API}/workspaces/${workspace.id}/channels`, {
    headers: { authorization: `Bearer ${accessToken}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });
  const channel = (await chRes.json()) as { id: string; name: string };

  // 1x1 transparent PNG.
  const pngBytes = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  );
  const clientAttachmentId = crypto.randomUUID();

  const presignRes = await ctx.request.post(`${API}/attachments/presign-upload`, {
    headers: { authorization: `Bearer ${accessToken}`, origin: ORIGIN },
    data: {
      clientAttachmentId,
      channelId: channel.id,
      mime: 'image/png',
      sizeBytes: pngBytes.length,
      originalName: 'pixel.png',
    },
  });
  expect(presignRes.status()).toBe(201);
  const presign = (await presignRes.json()) as {
    attachmentId: string;
    putUrl: string;
    key: string;
  };

  // Browser PUT to the presigned URL. `ctx.request.put` handles this
  // without CORS since Playwright's request API bypasses the browser.
  const putRes = await ctx.request.put(presign.putUrl, {
    headers: { 'content-type': 'image/png' },
    data: pngBytes,
  });
  expect(putRes.ok()).toBe(true);

  const finalizeRes = await ctx.request.post(
    `${API}/attachments/${presign.attachmentId}/finalize`,
    {
      headers: { authorization: `Bearer ${accessToken}`, origin: ORIGIN },
    },
  );
  expect(finalizeRes.status()).toBe(204);

  // Download-url round-trip confirms the object is readable.
  const dlRes = await ctx.request.get(`${API}/attachments/${presign.attachmentId}/download-url`, {
    headers: { authorization: `Bearer ${accessToken}`, origin: ORIGIN },
  });
  expect(dlRes.status()).toBe(200);
  const dl = (await dlRes.json()) as { downloadUrl: string };
  expect(dl.downloadUrl).toMatch(/X-Amz-Signature=/);

  // Second call with the same clientAttachmentId must return the same
  // attachmentId (idempotency).
  const presignReplay = await ctx.request.post(`${API}/attachments/presign-upload`, {
    headers: { authorization: `Bearer ${accessToken}`, origin: ORIGIN },
    data: {
      clientAttachmentId,
      channelId: channel.id,
      mime: 'image/png',
      sizeBytes: pngBytes.length,
      originalName: 'pixel.png',
    },
  });
  const presignReplayBody = (await presignReplay.json()) as { attachmentId: string };
  expect(presignReplayBody.attachmentId).toBe(presign.attachmentId);

  await ctx.close();
});
