import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  UPLOAD_RL_WINDOW_15M_MAX,
  UPLOAD_RL_WINDOW_1M_MAX,
  UPLOAD_RL_WINDOW_1M_SEC,
} from '@qufox/shared-types';
import { UploadRateLimitService } from './upload-rate-limit.service';
import { ErrorCode } from '../common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/**
 * 최소 in-memory Redis ZSET 스텁(vi.fn 만 — 외부 모킹 라이브러리 금지). 슬라이딩
 * 윈도우 동작(zadd/zremrangebyscore/zcard/expire/del)을 정직하게 흉내내 카운터
 * 로직을 검증한다.
 */
function makeRedisStub() {
  const store = new Map<string, Array<{ score: number; member: string }>>();

  function pipeline() {
    const ops: Array<() => unknown> = [];
    const api = {
      zremrangebyscore(key: string, min: number, max: number) {
        ops.push(() => {
          const arr = store.get(key) ?? [];
          store.set(
            key,
            arr.filter((e) => !(e.score >= min && e.score <= max)),
          );
          return 0;
        });
        return api;
      },
      zadd(key: string, score: number, member: string) {
        ops.push(() => {
          const arr = store.get(key) ?? [];
          arr.push({ score, member });
          store.set(key, arr);
          return 1;
        });
        return api;
      },
      zcard(key: string) {
        ops.push(() => (store.get(key) ?? []).length);
        return api;
      },
      expire() {
        ops.push(() => 1);
        return api;
      },
      async exec() {
        return ops.map((op) => [null, op()] as [null, unknown]);
      },
    };
    return api;
  }

  return {
    multi: () => pipeline(),
    del: async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    },
    __store: store,
  };
}

describe('S54 UploadRateLimitService — sliding window (FR-AM-27)', () => {
  it('allows up to the 1-minute limit then rejects', async () => {
    const redis = makeRedisStub();
    const svc = new UploadRateLimitService(redis as never);
    const now = new Date('2025-01-01T00:00:00Z');

    // 10 hits (1m max) — all allowed.
    for (let i = 0; i < UPLOAD_RL_WINDOW_1M_MAX; i++) {
      await expect(svc.enforceWindows('u1', 1, now)).resolves.toBeUndefined();
    }
    // 11th within the same minute — rejected.
    await expect(svc.enforceWindows('u1', 1, now)).rejects.toMatchObject({
      code: ErrorCode.UPLOAD_RATE_LIMIT,
    });
  });

  it('count>1 consumes multiple slots in one call', async () => {
    const redis = makeRedisStub();
    const svc = new UploadRateLimitService(redis as never);
    const now = new Date('2025-01-01T00:00:00Z');
    // One call requesting 10 sessions fills the 1m window exactly (allowed).
    await expect(svc.enforceWindows('u2', UPLOAD_RL_WINDOW_1M_MAX, now)).resolves.toBeUndefined();
    // The next single hit overflows.
    await expect(svc.enforceWindows('u2', 1, now)).rejects.toMatchObject({
      code: ErrorCode.UPLOAD_RATE_LIMIT,
    });
  });

  it('expires entries outside the window so a later request is allowed again', async () => {
    const redis = makeRedisStub();
    const svc = new UploadRateLimitService(redis as never);
    const t0 = new Date('2025-01-01T00:00:00Z');
    // Fill the 1m window.
    for (let i = 0; i < UPLOAD_RL_WINDOW_1M_MAX; i++) {
      await svc.enforceWindows('u3', 1, t0);
    }
    await expect(svc.enforceWindows('u3', 1, t0)).rejects.toMatchObject({
      code: ErrorCode.UPLOAD_RATE_LIMIT,
    });
    // Advance past the 1-minute window — old entries slide out.
    const later = new Date(t0.getTime() + (UPLOAD_RL_WINDOW_1M_SEC + 1) * 1000);
    await expect(svc.enforceWindows('u3', 1, later)).resolves.toBeUndefined();
  });

  it('15-minute window enforces its own higher cap', async () => {
    const redis = makeRedisStub();
    const svc = new UploadRateLimitService(redis as never);
    const base = new Date('2025-01-01T00:00:00Z');
    // Spread 60 hits across <15 minutes (1 per 10s = 590s total) so the 1m
    // window never trips (≤6 in any rolling minute) and all 60 stay strictly
    // inside the 15m window when the 61st arrives.
    for (let i = 0; i < UPLOAD_RL_WINDOW_15M_MAX; i++) {
      const at = new Date(base.getTime() + i * 10_000);
      await expect(svc.enforceWindows('u4', 1, at)).resolves.toBeUndefined();
    }
    // One more still inside the 15m window overflows the 15m cap.
    const at = new Date(base.getTime() + UPLOAD_RL_WINDOW_15M_MAX * 10_000);
    await expect(svc.enforceWindows('u4', 1, at)).rejects.toMatchObject({
      code: ErrorCode.UPLOAD_RATE_LIMIT,
    });
  });
});
