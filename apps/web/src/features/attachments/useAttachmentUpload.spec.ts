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

/** 기본 만료는 시스템시각(2025-01-01T00:00:00Z) + 1h — 잔여 충분(refresh 미발생). */
function session(id: string, expiresAt = '2025-01-01T01:00:00.000Z'): UploadSession {
  return {
    sessionId: id,
    storageKey: `k/${id}`,
    expiresAt,
    upload: PUT,
  };
}

const fileOf = (name: string, type: string): File => ({ name, type, size: 100 }) as unknown as File;

let uuidSeq = 0;
let revokeSpy: ReturnType<typeof vi.fn>;
let createSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  uuidSeq = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++uuidSeq}` });
  revokeSpy = vi.fn();
  createSpy = vi.fn(() => `blob:mock-${uuidSeq}`);
  vi.stubGlobal('URL', {
    createObjectURL: createSpy,
    revokeObjectURL: revokeSpy,
  });
  vi.stubGlobal('sessionStorage', makeMemoryStorage());
  requestUploadUrl.mockReset();
  uploadToStorage.mockReset();
  completeUpload.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** in-memory Storage 폴리필(jsdom sessionStorage 격리). */
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

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
    // S57: 전송 성공 항목은 confirmed 로 트레이에 남고, clearConfirmed 로 비운다.
    expect(result.current.items.every((i) => i.status === 'confirmed')).toBe(true);
    act(() => result.current.clearConfirmed());
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

  it('completeAndCollect: complete 실패 시 토스트 + [](항목은 failed 로 보존)', async () => {
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
      // 백오프 sleep 을 즉시 흘려보낸다(fake timer).
      vi.useRealTimers();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      const p = result.current.completeAndCollect();
      await vi.runAllTimersAsync();
      ids = await p;
      vi.useRealTimers();
    });
    expect(ids).toEqual([]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ variant: 'danger' }));
    // S57: 백오프 소진 후 failed 로 보존(재시도 가능).
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].status).toBe('failed');
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
    expect(revokeSpy).toHaveBeenCalled();
  });

  it('DM(wsId=null)이면 업로드를 시도하지 않고 failed 로 마킹', async () => {
    const { result } = renderHook(() => useAttachmentUpload(null, 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('p.png', 'image/png')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('failed'));
    expect(requestUploadUrl).not.toHaveBeenCalled();
  });

  it('MAJOR-1(데이터 손실): 1 ready + 1 failed → ready 만 전송하고 failed 는 트레이에 보존', async () => {
    // 첫 파일은 성공, 둘째 파일은 2단계(uploadToStorage)에서 실패.
    requestUploadUrl
      .mockResolvedValueOnce({ sessions: [session('s1')] })
      .mockResolvedValueOnce({ sessions: [session('s2')] });
    uploadToStorage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('net'), { errorCode: undefined }));
    completeUpload.mockResolvedValue({ attachmentIds: ['att-1'] });
    const notify = vi.fn();
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', notify));

    act(() =>
      result.current.addFiles([fileOf('ok.png', 'image/png'), fileOf('bad.png', 'image/png')]),
    );
    // 한 항목 ready, 다른 항목 failed 가 될 때까지 대기.
    await waitFor(() => {
      const statuses = result.current.items.map((i) => i.status).sort();
      expect(statuses).toEqual(['failed', 'ready']);
    });
    expect(result.current.failedCount).toBe(1);

    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.completeAndCollect();
    });

    // ready 항목만 complete 됨(1개).
    expect(ids).toEqual(['att-1']);
    expect(completeUpload).toHaveBeenCalledTimes(1);
    const body = completeUpload.mock.calls[0][2];
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sessionId).toBe('s1');

    // 핵심: failed 항목은 트레이에 보존되어야 한다(유실 금지). ready 는 confirmed.
    act(() => result.current.clearConfirmed());
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].status).toBe('failed');
    expect(result.current.items[0].file.name).toBe('bad.png');
  });

  it('MAJOR-1: 전송할 READY 가 없으면(failed 만) complete 호출 없이 트레이 보존', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockRejectedValue(new Error('net'));
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('bad.png', 'image/png')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('failed'));

    let ids: string[] = ['stale'];
    await act(async () => {
      ids = await result.current.completeAndCollect();
    });
    expect(ids).toEqual([]);
    expect(completeUpload).not.toHaveBeenCalled();
    // failed 항목 유지(이전 reset() 회귀 방지).
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].status).toBe('failed');
  });
});

// ── S57 (D11 / FR-AM-24) — 전송 상태 기계 ───────────────────────────────────
describe('useAttachmentUpload (S57 D11 — FR-AM-24 전송 상태 기계)', () => {
  it('상태 흐름: ready → sending → confirmed(프록시 URL + objectURL revoke)', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockResolvedValue(undefined);
    // complete 가 resolve 되기 전 sending 상태를 관측할 수 있게 deferred 사용.
    let resolveComplete: (v: { attachmentIds: string[] }) => void = () => {};
    completeUpload.mockReturnValue(
      new Promise((res) => {
        resolveComplete = res;
      }),
    );
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('p.png', 'image/png')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));
    const localUrl = result.current.items[0].previewUrl as string;

    let done: Promise<string[]> = Promise.resolve([]);
    act(() => {
      done = result.current.completeAndCollect();
    });
    // sending: 낙관적 전환 — 로컬 objectURL 유지.
    await waitFor(() => expect(result.current.items[0]?.status).toBe('sending'));
    expect(result.current.items[0].previewUrl).toBe(localUrl);
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(result.current.sendingCount).toBe(1);

    // complete 성공 → confirmed.
    await act(async () => {
      resolveComplete({ attachmentIds: ['att-9'] });
      await done;
    });
    expect(result.current.items[0].status).toBe('confirmed');
    // previewUrl 이 백엔드 프록시 URL 로 교체됨.
    expect(result.current.items[0].previewUrl).toContain('/attachments/att-9/download');
    // 로컬 objectURL 은 revoke 됨(CONFIRMED 경로).
    expect(revokeSpy).toHaveBeenCalledWith(localUrl);
  });

  it('★revokeObjectURL 은 CONFIRMED 와 FAILED 양쪽에서 호출된다', async () => {
    // 항목 2개: 둘 다 ready → 하나는 confirmed, 시나리오를 분리해 양쪽 검증.
    // (A) CONFIRMED 경로.
    requestUploadUrl.mockResolvedValue({ sessions: [session('sA')] });
    uploadToStorage.mockResolvedValue(undefined);
    completeUpload.mockResolvedValueOnce({ attachmentIds: ['att-A'] });
    const r1 = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    r1.result.current; // noop
    act(() => r1.result.current.addFiles([fileOf('a.png', 'image/png')]));
    await waitFor(() => expect(r1.result.current.items[0]?.status).toBe('ready'));
    const urlA = r1.result.current.items[0].previewUrl as string;
    await act(async () => {
      await r1.result.current.completeAndCollect();
    });
    expect(r1.result.current.items[0].status).toBe('confirmed');
    expect(revokeSpy).toHaveBeenCalledWith(urlA);

    revokeSpy.mockClear();

    // (B) FAILED 경로(백오프 소진).
    requestUploadUrl.mockResolvedValue({ sessions: [session('sB')] });
    completeUpload.mockReset();
    completeUpload.mockRejectedValue(Object.assign(new Error('boom'), { errorCode: undefined }));
    const r2 = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    act(() => r2.result.current.addFiles([fileOf('b.png', 'image/png')]));
    await waitFor(() => expect(r2.result.current.items[0]?.status).toBe('ready'));
    const urlB = r2.result.current.items[0].previewUrl as string;
    await act(async () => {
      vi.useRealTimers();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      const p = r2.result.current.completeAndCollect();
      await vi.runAllTimersAsync();
      await p;
      vi.useRealTimers();
    });
    expect(r2.result.current.items[0].status).toBe('failed');
    // FAILED 경로에서도 로컬 objectURL revoke.
    expect(revokeSpy).toHaveBeenCalledWith(urlB);
  });

  it('complete 지수 백오프: 2회 실패 후 3회차 성공(총 30s 예산 내 +10s·+20s)', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockResolvedValue(undefined);
    completeUpload
      .mockRejectedValueOnce(Object.assign(new Error('e1'), { errorCode: undefined }))
      .mockRejectedValueOnce(Object.assign(new Error('e2'), { errorCode: undefined }))
      .mockResolvedValueOnce({ attachmentIds: ['att-ok'] });
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('p.pdf', 'application/pdf')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));

    let ids: string[] = [];
    await act(async () => {
      vi.useRealTimers();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      const p = result.current.completeAndCollect();
      // 1차 즉시 실패 → +10s → 2차 실패 → +20s → 3차 성공.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(20_000);
      ids = await p;
      vi.useRealTimers();
    });
    expect(completeUpload).toHaveBeenCalledTimes(3);
    expect(ids).toEqual(['att-ok']);
    expect(result.current.items[0].status).toBe('confirmed');
  });

  it('complete 지수 백오프: 3회 모두 실패 → failed(complete 정확히 3회)', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockResolvedValue(undefined);
    completeUpload.mockRejectedValue(Object.assign(new Error('always'), { errorCode: undefined }));
    const notify = vi.fn();
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', notify));
    act(() => result.current.addFiles([fileOf('p.pdf', 'application/pdf')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));

    let ids: string[] = ['stale'];
    await act(async () => {
      vi.useRealTimers();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      const p = result.current.completeAndCollect();
      await vi.runAllTimersAsync();
      ids = await p;
      vi.useRealTimers();
    });
    expect(completeUpload).toHaveBeenCalledTimes(3);
    expect(ids).toEqual([]);
    expect(result.current.items[0].status).toBe('failed');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ variant: 'danger' }));
  });

  it('expiresAt on-demand refresh: 잔여<10s 면 complete 직전 upload-url 재요청 + 재업로드', async () => {
    // 첫 presign 의 만료는 시스템시각 +5s(잔여<10s) → refresh 트리거.
    requestUploadUrl
      .mockResolvedValueOnce({ sessions: [session('s1', '2025-01-01T00:00:05.000Z')] })
      .mockResolvedValueOnce({ sessions: [session('s1b', '2025-01-01T01:00:00.000Z')] });
    uploadToStorage.mockResolvedValue(undefined);
    completeUpload.mockResolvedValue({ attachmentIds: ['att-1'] });
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('p.pdf', 'application/pdf')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));
    expect(requestUploadUrl).toHaveBeenCalledTimes(1);

    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.completeAndCollect();
    });
    // refresh 로 upload-url 재요청(2회) + 재업로드(2회).
    expect(requestUploadUrl).toHaveBeenCalledTimes(2);
    expect(uploadToStorage).toHaveBeenCalledTimes(2);
    // complete 는 갱신된 세션 id(s1b)로 호출.
    const body = completeUpload.mock.calls[0][2];
    expect(body.sessions[0].sessionId).toBe('s1b');
    expect(ids).toEqual(['att-1']);
  });

  it('expiresAt 잔여 충분(>10s)이면 refresh 미발생', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockResolvedValue(undefined);
    completeUpload.mockResolvedValue({ attachmentIds: ['att-1'] });
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('p.pdf', 'application/pdf')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));

    await act(async () => {
      await result.current.completeAndCollect();
    });
    // upload-url 1회(초기 presign)만 — refresh 없음.
    expect(requestUploadUrl).toHaveBeenCalledTimes(1);
    expect(uploadToStorage).toHaveBeenCalledTimes(1);
  });
});

// ── S57 (D11 / FR-AM-28) — sessionStorage 세션 복구 ─────────────────────────
describe('useAttachmentUpload (S57 D11 — FR-AM-28 세션 복구)', () => {
  it('presign 확정 시 sessionStorage 에 등록, complete 성공 시 제거', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockResolvedValue(undefined);
    completeUpload.mockResolvedValue({ attachmentIds: ['att-1'] });
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('p.pdf', 'application/pdf')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));

    // presign 확정 → pending 등록.
    const stored = JSON.parse(sessionStorage.getItem('qufox:pending_sessions') ?? '[]');
    expect(stored).toEqual([{ sessionId: 's1', channelId: 'ch1' }]);

    await act(async () => {
      await result.current.completeAndCollect();
    });
    // complete 성공 → 제거.
    expect(sessionStorage.getItem('qufox:pending_sessions')).toBeNull();
  });

  it('removeItem 시 sessionStorage 에서 해당 세션 제거', async () => {
    requestUploadUrl.mockResolvedValue({ sessions: [session('s1')] });
    uploadToStorage.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAttachmentUpload('ws1', 'ch1', vi.fn()));
    act(() => result.current.addFiles([fileOf('p.pdf', 'application/pdf')]));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('ready'));
    expect(JSON.parse(sessionStorage.getItem('qufox:pending_sessions') ?? '[]')).toHaveLength(1);

    act(() => result.current.removeItem(result.current.items[0].id));
    expect(sessionStorage.getItem('qufox:pending_sessions')).toBeNull();
  });

  it('mount 시 leftover 세션이 있으면 info 토스트 + sessionStorage 클리어', async () => {
    sessionStorage.setItem(
      'qufox:pending_sessions',
      JSON.stringify([{ sessionId: 'old1', channelId: 'chX' }]),
    );
    const notify = vi.fn();
    renderHook(() => useAttachmentUpload('ws1', 'ch1', notify));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'info',
          title: expect.stringContaining('이전 업로드'),
        }),
      ),
    );
    // mount effect 가 sessionStorage 를 비운다(재진입 시 FAILED 인지).
    expect(sessionStorage.getItem('qufox:pending_sessions')).toBeNull();
  });

  it('mount 시 leftover 없으면 토스트 없음', async () => {
    const notify = vi.fn();
    renderHook(() => useAttachmentUpload('ws1', 'ch1', notify));
    // microtask 한 바퀴 — mount effect 실행 기회.
    await act(async () => {
      await Promise.resolve();
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
