import { describe, it, expect, beforeEach, vi } from 'vitest';
import { uploadErrorToast, UploadHttpError } from './uploadErrors';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function err(code?: string, status?: number): Error & { errorCode?: string; status?: number } {
  const e = new Error('boom') as Error & { errorCode?: string; status?: number };
  if (code) e.errorCode = code;
  if (status) e.status = status;
  return e;
}

describe('uploadErrorToast (S56 D11 FR-AM-22)', () => {
  it('maps ATTACHMENT_EXTENSION_BLOCKED with file context', () => {
    const t = uploadErrorToast(err('ATTACHMENT_EXTENSION_BLOCKED'), 'evil.exe');
    expect(t.title).toContain('허용되지 않는');
    expect(t.body).toContain('evil.exe');
  });

  it('maps MIME_MISMATCH', () => {
    expect(uploadErrorToast(err('MIME_MISMATCH')).title).toContain('형식 불일치');
  });

  it('maps ATTACHMENT_COUNT_EXCEEDED', () => {
    expect(uploadErrorToast(err('ATTACHMENT_COUNT_EXCEEDED')).title).toContain('개수');
  });

  it('maps UPLOAD_RATE_LIMIT', () => {
    expect(uploadErrorToast(err('UPLOAD_RATE_LIMIT')).body).toContain('잦습니다');
  });

  it('maps FILE_UPLOAD_DISABLED', () => {
    expect(uploadErrorToast(err('FILE_UPLOAD_DISABLED')).body).toContain('비활성화');
  });

  it('maps ATTACHMENT_SESSION_EXPIRED', () => {
    expect(uploadErrorToast(err('ATTACHMENT_SESSION_EXPIRED')).title).toContain('만료');
  });

  it('maps MinIO 413 (UploadHttpError) → too large', () => {
    const t = uploadErrorToast(new UploadHttpError(413), 'big.mp4');
    expect(t.title).toContain('너무 큼');
    expect(t.body).toContain('big.mp4');
  });

  it('maps MinIO 403 (UploadHttpError) → rejected', () => {
    expect(uploadErrorToast(new UploadHttpError(403)).title).toContain('거부');
  });

  it('also reads status from a plain error object (apiRequest bubble)', () => {
    expect(uploadErrorToast(err(undefined, 413)).title).toContain('너무 큼');
  });

  it('falls back to generic for unknown errors', () => {
    const t = uploadErrorToast(new Error('???'));
    expect(t.title).toBe('업로드 실패');
  });

  it('domain code wins over http status', () => {
    // 서버가 400 + ATTACHMENT_EXTENSION_BLOCKED 를 함께 보내면 code 우선.
    const t = uploadErrorToast(err('ATTACHMENT_EXTENSION_BLOCKED', 400));
    expect(t.title).toContain('허용되지 않는');
  });
});
