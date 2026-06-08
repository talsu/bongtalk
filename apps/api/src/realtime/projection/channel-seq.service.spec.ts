import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { SEQ_SENTINEL } from '@qufox/shared-types';
import { ChannelSeqService } from './channel-seq.service';

/**
 * S99 (S10 carryover · LOW): ChannelSeqService 의 seq 읽기 경로 NaN 가드 단위
 * 검증. 손상/비정수 Redis 값(Number('foo')=NaN)이 baseline 으로 흘러 클라
 * seqTracker 의 monotonic 비교를 영구 hole 로 굳히지 않도록, current()/
 * currentMany() 가 비유한 파싱 결과를 0 으로 정규화하는지 고정한다.
 */
describe('ChannelSeqService NaN 가드', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  function make(get: Redis['get'], mget: Redis['mget']): ChannelSeqService {
    const redis = { get, mget } as unknown as Redis;
    return new ChannelSeqService(redis);
  }

  describe('current()', () => {
    it('키 없음(null) → 0', async () => {
      const svc = make(vi.fn(async () => null) as never, vi.fn() as never);
      await expect(svc.current('c1')).resolves.toBe(0);
    });

    it('정상 정수 문자열 → 그 값', async () => {
      const svc = make(vi.fn(async () => '42') as never, vi.fn() as never);
      await expect(svc.current('c1')).resolves.toBe(42);
    });

    it('비정수/손상 값(NaN 유발) → 0 (영구 hole 방지)', async () => {
      const svc = make(vi.fn(async () => 'not-a-number') as never, vi.fn() as never);
      const v = await svc.current('c1');
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBe(0);
    });

    it('Redis 장애(throw) → SEQ_SENTINEL', async () => {
      const svc = make(
        vi.fn(async () => {
          throw new Error('connreset');
        }) as never,
        vi.fn() as never,
      );
      await expect(svc.current('c1')).resolves.toBe(SEQ_SENTINEL);
    });
  });

  describe('currentMany()', () => {
    it('빈 배열 → 빈 Map', async () => {
      const svc = make(vi.fn() as never, vi.fn() as never);
      const out = await svc.currentMany([]);
      expect(out.size).toBe(0);
    });

    it('정상/없음/손상 혼재 → 손상·없음은 0 으로 정규화', async () => {
      const mget = vi.fn(async () => ['7', null, 'garbage', undefined]);
      const svc = make(vi.fn() as never, mget as never);
      const out = await svc.currentMany(['a', 'b', 'c', 'd']);
      expect(out.get('a')).toBe(7);
      expect(out.get('b')).toBe(0);
      // 손상 값이 NaN 으로 새지 않고 0 으로 떨어진다.
      expect(Number.isNaN(out.get('c'))).toBe(false);
      expect(out.get('c')).toBe(0);
      expect(out.get('d')).toBe(0);
    });

    it('Redis 장애(throw) → 전체 SEQ_SENTINEL', async () => {
      const mget = vi.fn(async () => {
        throw new Error('mget down');
      });
      const svc = make(vi.fn() as never, mget as never);
      const out = await svc.currentMany(['a', 'b']);
      expect(out.get('a')).toBe(SEQ_SENTINEL);
      expect(out.get('b')).toBe(SEQ_SENTINEL);
    });
  });
});
