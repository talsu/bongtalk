import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoverCacheService, type DiscoverCacheKeyInput } from './discover-cache.service';

/**
 * S72 (D13 / FR-W16): 서버 디스커버리 검색 Redis 5분 캐시 단위 테스트.
 *
 * - 캐시 키는 (category|q|cursor|limit) + 버전으로 결정되며, 같은 입력은 같은 키를,
 *   다른 입력은 다른 키를 낸다(안정 해시).
 * - read() 는 MISS(null)/HIT(payload) 분기를 그대로 돌려주고, write() 는 TTL 60s 로
 *   SET EX 한다(W16 fix-forward HIGH-1: 300→60 축소).
 * - invalidate() 는 버전 키(discover:ver)를 INCR 해 이후 모든 키 네임스페이스를 바꾼다
 *   (NAS 단일 노드 권장 전략 — SCAN/DEL 대신 버전 bump, 구키는 TTL 로 자연 소멸).
 *
 * 외부는 vi.fn() 만으로 모킹한다(ioredis 스텁). vi.setSystemTime 으로 시간 고정.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

type RedisStub = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
};

function makeRedis(initial: Record<string, string> = {}): RedisStub {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    incr: vi.fn(async (k: string) => {
      const next = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(next));
      return next;
    }),
  };
}

const BASE: DiscoverCacheKeyInput = { category: 'GAMING', q: 'rust', cursor: null, limit: 20 };

describe('DiscoverCacheService — key derivation', () => {
  it('produces a stable key for identical inputs at the same version', async () => {
    const svc = new DiscoverCacheService(makeRedis({ 'discover:ver': '3' }) as never);
    const a = await svc.keyFor(BASE);
    const b = await svc.keyFor({ ...BASE });
    expect(a).toBe(b);
    expect(a).toMatch(/^discover:v3:/);
  });

  it('produces different keys when any field differs', async () => {
    const svc = new DiscoverCacheService(makeRedis({ 'discover:ver': '1' }) as never);
    const base = await svc.keyFor(BASE);
    const byCat = await svc.keyFor({ ...BASE, category: 'PROGRAMMING' });
    const byQ = await svc.keyFor({ ...BASE, q: 'typescript' });
    const byCursor = await svc.keyFor({ ...BASE, cursor: '10|abc' });
    const byLimit = await svc.keyFor({ ...BASE, limit: 50 });
    const all = [base, byCat, byQ, byCursor, byLimit];
    expect(new Set(all).size).toBe(all.length);
  });

  it('normalises category/q so blank category and blank q collapse', async () => {
    const svc = new DiscoverCacheService(makeRedis({ 'discover:ver': '1' }) as never);
    const a = await svc.keyFor({ category: undefined, q: undefined, cursor: null, limit: 20 });
    const b = await svc.keyFor({ category: '', q: '', cursor: null, limit: 20 });
    expect(a).toBe(b);
  });

  // S72 W16 fix-forward (MEDIUM-2): q 를 toLowerCase() 정규화해 ILIKE 와 대칭 — 대소문자만
  // 다른 검색어는 같은 키로 적중한다(적중률↑).
  it('normalises q to lower-case so case-only variants collapse', async () => {
    const svc = new DiscoverCacheService(makeRedis({ 'discover:ver': '1' }) as never);
    const lower = await svc.keyFor({ ...BASE, q: 'rust' });
    const upper = await svc.keyFor({ ...BASE, q: 'RUST' });
    const mixed = await svc.keyFor({ ...BASE, q: 'RuSt' });
    expect(lower).toBe(upper);
    expect(lower).toBe(mixed);
  });

  // S72 W16 fix-forward (MEDIUM-3): 해시 자릿수를 16→32 로 늘려 충돌→오답 서빙 위험을
  // 낮춘다(키 형태가 32 hex 임을 고정).
  it('uses a 32-hex-char hash segment in the key', async () => {
    const svc = new DiscoverCacheService(makeRedis({ 'discover:ver': '7' }) as never);
    const key = await svc.keyFor(BASE);
    expect(key).toMatch(/^discover:v7:[0-9a-f]{32}$/);
  });

  it('defaults the version to 0 when no version key exists yet', async () => {
    const svc = new DiscoverCacheService(makeRedis() as never);
    const key = await svc.keyFor(BASE);
    expect(key).toMatch(/^discover:v0:/);
  });
});

describe('DiscoverCacheService — read / write', () => {
  it('read() returns null on MISS', async () => {
    const redis = makeRedis({ 'discover:ver': '0' });
    const svc = new DiscoverCacheService(redis as never);
    const hit = await svc.read('discover:v0:abc');
    expect(hit).toBeNull();
    expect(redis.get).toHaveBeenCalledWith('discover:v0:abc');
  });

  it('read() returns the parsed payload on HIT', async () => {
    const payload = { items: [{ id: 'w1' }], nextCursor: null };
    const redis = makeRedis({ 'discover:v0:abc': JSON.stringify(payload) });
    const svc = new DiscoverCacheService(redis as never);
    const hit = await svc.read<typeof payload>('discover:v0:abc');
    expect(hit).toEqual(payload);
  });

  it('write() stores the payload with a 60s TTL via SET EX', async () => {
    const redis = makeRedis({ 'discover:ver': '0' });
    const svc = new DiscoverCacheService(redis as never);
    const payload = { items: [], nextCursor: null };
    await svc.write('discover:v0:abc', payload);
    expect(redis.set).toHaveBeenCalledWith('discover:v0:abc', JSON.stringify(payload), 'EX', 60);
  });
});

describe('DiscoverCacheService — invalidation', () => {
  it('invalidate() bumps the version key so subsequent keys move namespace', async () => {
    const redis = makeRedis({ 'discover:ver': '4' });
    const svc = new DiscoverCacheService(redis as never);
    const before = await svc.keyFor(BASE);
    expect(before).toMatch(/^discover:v4:/);

    await svc.invalidate();
    expect(redis.incr).toHaveBeenCalledWith('discover:ver');

    const after = await svc.keyFor(BASE);
    expect(after).toMatch(/^discover:v5:/);
    expect(after).not.toBe(before);
  });
});
