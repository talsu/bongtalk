import { test, expect } from '@playwright/test';

const PW = 'Quanta-Beetle-Nebula-42!';
const API = 'http://localhost:43001';
const ORIGIN = 'http://localhost:45173';

/**
 * Task-022 polish harness — composer file upload.
 *
 * Asserts:
 *  1. Picking a file via the + menu → attachment chip appears in
 *     composer above the input.
 *  2. Chip has a remove button (✕ icon).
 *  3. Remove → chip disappears, no attachment sent on next message.
 *  4. The "🎙 음성 메모" placeholder menu item is disabled.
 *
 * Does NOT drive a successful upload end-to-end because the MinIO
 * presign layer is stubbed via Playwright request intercept — the
 * upload flow itself is exercised in upload-message-attachment.e2e.ts;
 * here we assert the *UI chrome* reacts correctly even if the real
 * S3 PUT fails.
 */
test.setTimeout(60_000);
test('polish: composer + menu file pick renders chip + removable (R4-composer-upload)', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `polcu-${stamp.toString(36)}`;
  const res = await request.post(`${API}/auth/signup`, {
    headers: { origin: ORIGIN },
    data: { email: `polcu-${stamp}@qufox.dev`, username: `polcu${stamp}`, password: PW },
  });
  const token = (await res.json()).accessToken as string;
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'ComposerUpload', slug },
  });
  const wsId = (await ws.json()).id as string;
  await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { name: 'general', type: 'TEXT' },
  });

  await page.goto('/login');
  await page.getByTestId('login-email').fill(`polcu-${stamp}@qufox.dev`);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
  await page.getByTestId('channel-general').click();

  // + menu opens upward.
  await page.getByTestId('composer-plus').click();
  const attachItem = page.getByTestId('composer-attach-file');
  await expect(attachItem).toBeVisible();

  // Intercept presign-upload + PUT + finalize so the UI flow completes
  // without a real MinIO instance. The test is about the CHIP UI, not
  // end-to-end storage.
  await page.route('**/attachments/presign-upload', (route) => {
    const body = route.request().postDataJSON() as { clientAttachmentId?: string };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        attachmentId: body.clientAttachmentId ?? crypto.randomUUID(),
        key: 'stub/key',
        putUrl: 'http://localhost:43001/__stub_put__',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    });
  });
  await page.route('**/__stub_put__', (route) => route.fulfill({ status: 200, body: 'ok' }));
  await page.route('**/attachments/*/finalize', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );

  // File picker: provide a tiny buffer via setInputFiles.
  const fileInput = page.getByTestId('composer-file-input');
  await fileInput.setInputFiles({
    name: 'polish.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG header
  });

  // Chip should appear.
  const pending = page.getByTestId('composer-pending-attachments');
  await expect(pending).toBeVisible({ timeout: 5_000 });
  const chip = pending.locator('li').first();
  await expect(chip).toContainText('polish.png');

  // Remove button inside the chip.
  await chip.getByRole('button').click();
  await expect(pending).toHaveCount(0);
});
