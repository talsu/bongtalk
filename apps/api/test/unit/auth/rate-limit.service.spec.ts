import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitService } from '../../../src/auth/services/rate-limit.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

function makeRedis() {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    async incr(key: string) {
      const v = (counts.get(key) ?? 0) + 1;
      counts.set(key, v);
      return v;
    },
    async expire(key: string, sec: number) {
      ttls.set(key, sec);
      return 1;
    },
    async ttl(key: string) {
      return ttls.get(key) ?? -1;
    },
    async del(key: string) {
      counts.delete(key);
      ttls.delete(key);
      return 1;
    },
    counts,
    ttls,
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('RateLimitService', () => {
  it('allows up to max, blocks above max, carries retryAfterSec', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new RateLimitService(redis as any);
    const rule = { key: 'login:ip:1.1.1.1', windowSec: 60, max: 2 };
    await svc.enforce([rule]); // 1
    await svc.enforce([rule]); // 2
    try {
      await svc.enforce([rule]); // 3 → boom
      throw new Error('should throw');
    } catch (e) {
      expect((e as DomainError).code).toBe(ErrorCode.RATE_LIMITED);
      const details = (e as DomainError).details as { retryAfterSec: number };
      expect(details.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it('resets a bucket', async () => {
    const redis = makeRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new RateLimitService(redis as any);
    const rule = { key: 'foo', windowSec: 60, max: 1 };
    await svc.enforce([rule]);
    await svc.reset('foo');
    await svc.enforce([rule]); // fresh bucket, not rate limited
  });
});
