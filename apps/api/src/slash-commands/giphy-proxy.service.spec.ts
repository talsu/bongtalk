import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GiphyProxyService, type GiphyFetch } from './giphy-proxy.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S81b (D15 / FR-SC-07) — GiphyProxyService 단위 테스트.
 *
 * HTTP 경계(GiphyFetch)와 Redis 는 vi.fn() 으로만 모킹한다(외부 모킹 라이브러리 금지).
 * 시간 고정(2025-01-01). API 키는 테스트에서 직접 주입해 env 의존을 제거한다.
 */

const ENV_KEY = 'test-giphy-key';

function giphyBody(gifId: string, title = 'cat') {
  return {
    data: [
      {
        title,
        images: {
          original: { url: `https://media.giphy.com/media/${gifId}/giphy.gif` },
          fixed_width: { url: `https://media.giphy.com/media/${gifId}/200w.gif` },
        },
      },
    ],
  };
}

type RedisLike = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
};

function makeRedis(initial: Record<string, string> = {}): RedisLike {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  };
}

function okFetch(body: unknown, status = 200): GiphyFetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

function makeService(opts: {
  apiKey?: string | undefined;
  redis?: RedisLike;
  fetch?: GiphyFetch;
}): { service: GiphyProxyService; redis: RedisLike; fetch: GiphyFetch } {
  const redis = opts.redis ?? makeRedis();
  const fetch = opts.fetch ?? okFetch(giphyBody('abc'));
  const service = new GiphyProxyService(redis as never, fetch, () => opts.apiKey);
  return { service, redis, fetch };
}

describe('GiphyProxyService', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('성공 응답에서 gifUrl/gifThumbUrl/title 을 추출한다', async () => {
    const { service, fetch } = makeService({ apiKey: ENV_KEY });
    const res = await service.search('cat', 0);
    expect(res).toEqual({
      gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
      gifThumbUrl: 'https://media.giphy.com/media/abc/200w.gif',
      title: 'cat',
    });
    // API 키는 서버 env 에서만 — 호출 URL 에 키가 실린다(클라가 아니라 서버가 붙임).
    const url = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toContain('api.giphy.com/v1/gifs/search');
    expect(url).toContain(`api_key=${ENV_KEY}`);
    expect(url).toContain('offset=0');
    expect(url).toContain('rating=pg-13');
  });

  it('API 키 미설정이면 GIPHY_UNAVAILABLE(503) 을 던진다', async () => {
    const { service, fetch } = makeService({ apiKey: undefined });
    await expect(service.search('cat', 0)).rejects.toMatchObject({
      code: ErrorCode.GIPHY_UNAVAILABLE,
    });
    // 키가 없으면 외부 호출을 시도하지 않는다.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('빈 키(공백)도 미설정으로 간주한다', async () => {
    const { service } = makeService({ apiKey: '   ' });
    await expect(service.search('cat', 0)).rejects.toBeInstanceOf(DomainError);
  });

  it('결과 0건이면 null 을 반환한다(GIPHY 정상 — 에러 아님)', async () => {
    const { service } = makeService({ apiKey: ENV_KEY, fetch: okFetch({ data: [] }) });
    const res = await service.search('zzzznope', 0);
    expect(res).toBeNull();
  });

  it('GIPHY 가 비-2xx 면 GIPHY_UNAVAILABLE 을 던진다', async () => {
    const { service } = makeService({
      apiKey: ENV_KEY,
      fetch: okFetch({ message: 'rate limited' }, 429),
    });
    await expect(service.search('cat', 0)).rejects.toMatchObject({
      code: ErrorCode.GIPHY_UNAVAILABLE,
    });
  });

  it('fetch 자체가 실패(throw)하면 GIPHY_UNAVAILABLE 을 던진다', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const { service } = makeService({ apiKey: ENV_KEY, fetch });
    await expect(service.search('cat', 0)).rejects.toMatchObject({
      code: ErrorCode.GIPHY_UNAVAILABLE,
    });
  });

  it('응답 형식이 깨졌으면(필수 URL 누락) GIPHY_UNAVAILABLE 을 던진다', async () => {
    const broken = { data: [{ title: 'x', images: { original: {}, fixed_width: {} } }] };
    const { service } = makeService({ apiKey: ENV_KEY, fetch: okFetch(broken) });
    await expect(service.search('cat', 0)).rejects.toMatchObject({
      code: ErrorCode.GIPHY_UNAVAILABLE,
    });
  });

  it('Redis 캐시 hit 면 HTTP 를 호출하지 않는다', async () => {
    const cached = JSON.stringify({
      gifUrl: 'https://media.giphy.com/media/cached/giphy.gif',
      gifThumbUrl: 'https://media.giphy.com/media/cached/200w.gif',
      title: 'cached',
    });
    const redis = makeRedis({ 'giphy:cat:0': cached });
    const { service, fetch } = makeService({ apiKey: ENV_KEY, redis });
    const res = await service.search('cat', 0);
    expect(res?.title).toBe('cached');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('캐시 miss 면 HTTP 호출 후 TTL 300s 로 캐시한다', async () => {
    const redis = makeRedis();
    const { service, redis: r } = makeService({ apiKey: ENV_KEY, redis });
    await service.search('cat', 2);
    expect(r.set).toHaveBeenCalledWith('giphy:cat:2', expect.any(String), 'EX', 300);
  });

  it('키워드를 정규화해 캐시 키를 만든다(대소문자/공백)', async () => {
    const redis = makeRedis();
    const { service, redis: r } = makeService({ apiKey: ENV_KEY, redis });
    await service.search('  Cat  ', 0);
    expect(r.set).toHaveBeenCalledWith('giphy:cat:0', expect.any(String), 'EX', 300);
  });
});
