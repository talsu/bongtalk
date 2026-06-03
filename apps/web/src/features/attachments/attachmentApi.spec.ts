import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { UploadSession } from '@qufox/shared-types';
import { uploadToStorage } from './attachmentApi';
import { UploadHttpError } from './uploadErrors';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 결정적 XHR 목. open/send/setRequestHeader 를 캡처하고, 테스트가 onprogress/
 * onload/onerror 를 수동 발화한다. vi.fn() 만 사용(외부 모킹 라이브러리 금지).
 */
class FakeXhr {
  static last: FakeXhr | null = null;
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  opened: { method: string; url: string } | null = null;
  headers: Record<string, string> = {};
  sentBody: unknown = null;
  constructor() {
    FakeXhr.last = this;
  }
  open = vi.fn((method: string, url: string) => {
    this.opened = { method, url };
  });
  setRequestHeader = vi.fn((k: string, v: string) => {
    this.headers[k] = v;
  });
  send = vi.fn((body?: unknown) => {
    this.sentBody = body ?? null;
  });
  emitProgress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  finish(status: number): void {
    this.status = status;
    this.onload?.();
  }
  fail(): void {
    this.status = 0;
    this.onerror?.();
  }
}

const fileOf = (name: string, type: string): File => ({ name, type, size: 10 }) as unknown as File;

describe('uploadToStorage (S56 D11 — MinIO 직접 업로드 XHR)', () => {
  it('POST: appends presigned fields in order then file last (FormData)', async () => {
    const upload: UploadSession['upload'] = {
      method: 'POST',
      url: 'https://minio.local/bucket',
      fields: { key: 'k1', policy: 'p1', 'x-amz-signature': 'sig' },
    };
    const appended: string[] = [];
    const formAppend = vi.spyOn(FormData.prototype, 'append').mockImplementation(function (
      this: FormData,
      name: string,
    ) {
      appended.push(name);
    } as unknown as typeof FormData.prototype.append);

    const progress = vi.fn();
    const p = uploadToStorage(upload, fileOf('a.png', 'image/png'), progress, FakeXhr as never);
    const xhr = FakeXhr.last as unknown as FakeXhr;
    xhr.emitProgress(5, 10);
    xhr.finish(204);
    await p;

    expect(xhr.opened).toEqual({ method: 'POST', url: 'https://minio.local/bucket' });
    // fields 순서 보존 + file 마지막.
    expect(appended).toEqual(['key', 'policy', 'x-amz-signature', 'file']);
    expect(progress).toHaveBeenCalledWith(50);
    expect(progress).toHaveBeenLastCalledWith(100);
    formAppend.mockRestore();
  });

  it('PUT: sends file as body with Content-Type header', async () => {
    const upload: UploadSession['upload'] = {
      method: 'PUT',
      url: 'https://minio.local/put-target',
      fields: {},
    };
    const file = fileOf('clip.mp4', 'video/mp4');
    const p = uploadToStorage(upload, file, undefined, FakeXhr as never);
    const xhr = FakeXhr.last as unknown as FakeXhr;
    xhr.finish(200);
    await p;
    expect(xhr.opened).toEqual({ method: 'PUT', url: 'https://minio.local/put-target' });
    expect(xhr.headers['Content-Type']).toBe('video/mp4');
    expect(xhr.sentBody).toBe(file);
  });

  it('rejects with UploadHttpError on non-2xx (413)', async () => {
    const upload: UploadSession['upload'] = { method: 'PUT', url: 'u', fields: {} };
    const p = uploadToStorage(
      upload,
      fileOf('big', 'application/zip'),
      undefined,
      FakeXhr as never,
    );
    const xhr = FakeXhr.last as unknown as FakeXhr;
    xhr.finish(413);
    await expect(p).rejects.toBeInstanceOf(UploadHttpError);
    await expect(p).rejects.toMatchObject({ status: 413 });
  });

  it('rejects with UploadHttpError on network error', async () => {
    const upload: UploadSession['upload'] = { method: 'PUT', url: 'u', fields: {} };
    const p = uploadToStorage(upload, fileOf('x', 'image/png'), undefined, FakeXhr as never);
    const xhr = FakeXhr.last as unknown as FakeXhr;
    xhr.fail();
    await expect(p).rejects.toBeInstanceOf(UploadHttpError);
  });

  it('perf: 정수 % 가 바뀔 때만 onProgress 호출(중복 진행 이벤트 throttle)', async () => {
    const upload: UploadSession['upload'] = { method: 'PUT', url: 'u', fields: {} };
    const progress = vi.fn();
    const p = uploadToStorage(
      upload,
      fileOf('a.bin', 'application/octet-stream'),
      progress,
      FakeXhr as never,
    );
    const xhr = FakeXhr.last as unknown as FakeXhr;
    // 같은 정수 %(33%)로 떨어지는 연속 이벤트는 1번만 통지.
    xhr.emitProgress(33, 100);
    xhr.emitProgress(33, 100);
    xhr.emitProgress(331, 1000); // 33%
    xhr.emitProgress(66, 100); // 66% — 새 값.
    xhr.finish(200); // 100% — 새 값.
    await p;
    expect(progress.mock.calls.map((c) => c[0])).toEqual([33, 66, 100]);
  });
});
