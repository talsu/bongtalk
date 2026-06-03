// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// getAccessToken 모킹(인증 헤더 — 캐시 테스트엔 무관).
vi.mock('../../lib/api', () => ({
  getAccessToken: () => 'tok',
}));

import {
  fetchAttachmentObjectUrl,
  downloadAttachment,
  __resetAttachmentUrlCache,
} from './attachmentSrc';

let urlSeq = 0;

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  urlSeq = 0;
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => `blob:mock-${++urlSeq}`),
    revokeObjectURL: vi.fn(),
  });
  __resetAttachmentUrlCache();
});
afterEach(() => {
  __resetAttachmentUrlCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    blob: async () => new Blob(['x']),
  })) as unknown as ReturnType<typeof vi.fn>;
}

describe('attachmentSrc LRU objectURL 캐시 (S56 fix-forward — perf CRITICAL)', () => {
  it('동일 id:variant 재요청은 fetch 를 생략하고 캐시된 objectURL 반환(캐시 hit)', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);

    const u1 = await fetchAttachmentObjectUrl('a1', 'download');
    const u2 = await fetchAttachmentObjectUrl('a1', 'download');

    expect(u1).toBe(u2);
    // fetch 는 첫 요청에서만 1회 — 채널 재진입(재마운트) 재fetch 회피.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('다른 variant 는 별도 캐시 엔트리(thumbnail vs download)', async () => {
    const f = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      blob: async () => new Blob([url]),
    }));
    vi.stubGlobal('fetch', f as never);

    const t = await fetchAttachmentObjectUrl('a1', 'thumbnail');
    const d = await fetchAttachmentObjectUrl('a1', 'download');
    expect(t).not.toBe(d);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('동시 요청 dedup: in-flight 인 동일 key 는 같은 Promise 를 공유(fetch 1회)', async () => {
    // fetch 는 1 tick 지연 후 resolve — 첫 호출이 in-flight 인 동안 둘째 호출이
    // 같은 Promise 를 공유하는지 검증한다.
    const f = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: true,
                status: 200,
                blob: async () => new Blob(['x']),
              } as unknown as Response),
            0,
          );
        }),
    );
    vi.stubGlobal('fetch', f as never);

    const p1 = fetchAttachmentObjectUrl('a1', 'download');
    const p2 = fetchAttachmentObjectUrl('a1', 'download');
    const [u1, u2] = await Promise.all([p1, p2]);
    expect(u1).toBe(u2);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('thumbnail 202 → download 원본 폴백(2회 fetch)', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith('/thumbnail')) {
        return { ok: false, status: 202, blob: async () => new Blob(['t']) } as unknown as Response;
      }
      return { ok: true, status: 200, blob: async () => new Blob(['d']) } as unknown as Response;
    });
    vi.stubGlobal('fetch', f as never);
    const u = await fetchAttachmentObjectUrl('a1', 'thumbnail');
    expect(u).toContain('blob:mock');
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('downloadAttachment (security LOW — 경로구분자 방어)', () => {
  it('originalName 의 / 및 \\ 를 _ 로 치환해 download 속성에 세팅', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['x']) })) as never,
    );
    let captured: HTMLAnchorElement | null = null;
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') {
        captured = el as HTMLAnchorElement;
        el.click = vi.fn();
      }
      return el;
    });

    await downloadAttachment('a1', '../../etc/pass\\wd.txt');
    expect(captured).not.toBeNull();
    expect((captured as unknown as HTMLAnchorElement).download).toBe('.._.._etc_pass_wd.txt');
  });
});
