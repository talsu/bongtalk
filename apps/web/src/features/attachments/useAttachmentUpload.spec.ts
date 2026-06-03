// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { UploadSession } from '@qufox/shared-types';

// ── attachmentApi 모킹(3단계 네트워크) ──────────────────────────────────────
const requestUploadUrl = vi.fn();
const uploadToStorage = vi.fn();
const completeUpload = vi.fn();
vi.mock('./attachmentApi', () => ({
  requestUploadUrl: (...a: unknown[]) => requestUploadUrl(...a),
  uploadToStorage: (...a: unknown[]) => uploadToStorage(...a),
  completeUpload: (...a: unknown[]) => completeUpload(...a),
}));

import { useAttachmentUpload } from './useAttachmentUpload';

const PUT: UploadSession['upload'] = { method: 'PUT', url: 'u', fields: {} };

function session(id: string): UploadSession {
  return {
    sessionId: id,
    storageKey: `k/${id}`,
    expiresAt: '2025-01-01T01:00:00.000Z',
    upload: PUT,
  };
}

const fileOf = (name: string, type: string): File => ({ name, type, size: 100 }) as unknown as File;

let uuidSeq = 0;

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  uuidSeq = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++uuidSeq}` });
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => `blob:mock-${uuidSeq}`),
    revokeObjectURL: vi.fn(),
  });
  requestUploadUrl.mockReset();
  uploadToStorage.mockReset();
  completeUpload.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useAttachmentUpload (S56 D11 — 3단계 업로드 트레이)', () => {
  it('addFiles → 단계1+2 성공 시 status ready, sessionId 설정', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockImplementation(
      async (_u: unknown, _f: unknown, onProgress?: (p: number) => void) => {
        onProgress?.(50);
        onProgress?.(100);
      },
    );
    const notify = vi.fn();
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', notify));

    act(() => result.current.addFiles([fileOf('doc.pdf', 'application/pdf')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));

    expect(result.current.items[0].sessionId).toBe('s1');
    expect(requestUploadUrl).toHaveBeenCalledWith('ws1', 'ch1', {
      filename: 'doc.pdf',
      size: 100,
      mimeType: 'application/pdf',
      count: 1,
    });
    expect(result.current.uploadingCount).toBe(0);
  });

  it('업로드 실패 시 status failed + danger 토스트', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    const e = new Error('nope') as Error & { errorCode?: string };
    e.errorCode = 'FILE_UPLOAD_DISABLED';
    uploadToStorage.mockRejectedValue(e);
    const notify = vi.fn();
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', notify));

    act(() => result.current.addFiles([fileOf('x.png', 'image/png')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('failed'));

    expect(result.current.failedCount).toBe(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger', title: expect.stringContaining('비활성화') }),
    );
  });

  it('IMAGE 는 previewUrl(objectURL) 생성', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('p.png', 'image/png')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));
    expect(result.current.items[0].previewUrl).toContain('blob:mock');
    expect(result.current.items[0].kind).toBe('IMAGE');
  });

  it('toggleSpoiler / setAltText 업데이트', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('p.png', 'image/png')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));
    const id = result.current.items[0].id;
    act(() => result.current.toggleSpoiler(id));
    expect(result.current.items[0].isSpoiler).toBe(true);
    act(() => result.current.setAltText(id, '고양이 사진'));
    expect(result.current.items[0].altText).toBe('고양이 사진');
  });

  it('completeAndCollect: READY 항목을 sortOrder 인덱스로 complete → attachmentIds', async () => {
    requestUploadUrl
      .mockResolvedValueOnce({ sessions: [session('s1')] })
      .mockResolvedValueOnce({ sessions: [session('s2')] });
    uploadToStorage.mockResolvedValue(undefined);
    completeUpload.mockResolvedValue({ attachmentIds: ['att-1', 'att-2'] });
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));

    act(() =>
      result.current.addFiles([fileOf('a.png', 'image/png'), fileOf('b.pdf', 'application/pdf')]),
    );
    await waitFor(() => expect(result.current.items.every((i) => i.status === 'ready')).toBe(true));

    // 첫 항목에 alt + spoiler 부여.
    act(() => result.current.setAltText(result.current.items[0].id, '설명'));
    act(() => result.current.toggleSpoiler(result.current.items[0].id));

    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.completeAndCollect();
    });
    expect(ids).toEqual(['att-1', 'att-2']);
    const body = completeUpload.mock.calls[0][2];
    expect(body.targetChannelId).toBe('ch1');
    expect(body.sessions).toEqual([
      { sessionId: 's1', sortOrder: 0, altText: '설명', isSpoiler: true },
      { sessionId: 's2', sortOrder: 1 },
    ]);
    // 트레이 비워짐.
    expect(result.current.items).toHaveLength(0);
  });

  it('completeAndCollect: 항목 없으면 [] + 호출 없음', async () => {
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    let ids: string[] = ['stale'];
    await act(async () => {
      ids = await result.current.completeAndCollect();
    });
    expect(ids).toEqual([]);
    expect(completeUpload).not.toHaveBeenCalled();
  });

  it('completeAndCollect: complete 실패 시 토스트 + [](트레이 유지)', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockResolvedValue(undefined);
    const e = new Error('rl') as Error & { errorCode?: string };
    e.errorCode = 'UPLOAD_RATE_LIMIT';
    completeUpload.mockRejectedValue(e);
    const notify = vi.fn();
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', notify));
    act(() => result.current.addFiles([fileOf('a.png', 'image/png')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));

    let ids: string[] = ['stale'];
    await act(async () => {
      ids = await result.current.completeAndCollect();
    });
    expect(ids).toEqual([]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ variant: 'danger' }));
    // complete 실패라 트레이는 유지(재시도 가능).
    expect(result.current.items).toHaveLength(1);
  });

  it('removeItem 은 항목 제거 + objectURL revoke', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('p.png', 'image/png')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));
    const id = result.current.items[0].id;
    act(() => result.current.removeItem(id));
    expect(result.current.items).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('DM(wsId=null)이면 업로드를 시도하지 않고 failed 로 마킹', async () => {
    const { result } = renderHook(() => useAttachmentUpload(null, 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('p.png', 'image/png')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('failed'));
    expect(requestUploadUrl).not.toHaveBeenCalled();
  });
});
