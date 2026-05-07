import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatusBroadcastThrottler } from '../../../src/me/status-broadcast-throttler';

/**
 * task-046 iter0 (MED-1 carry-over): user.profile.updated broadcast 를
 * (userId, windowMs) 단위 coalesce 하는 throttler 검증.
 */

describe('StatusBroadcastThrottler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    process.env.STATUS_BROADCAST_THROTTLE_MS = '5000';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.STATUS_BROADCAST_THROTTLE_MS;
  });

  it('첫 호출은 windowMs 후 flush 발화', async () => {
    const t = new StatusBroadcastThrottler();
    const flush = vi.fn().mockResolvedValue(undefined);
    t.schedule('user-1', flush);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('window 내 동일 user 의 추가 호출은 drop — 1 회 flush', async () => {
    const t = new StatusBroadcastThrottler();
    const flush = vi.fn().mockResolvedValue(undefined);
    t.schedule('user-1', flush);
    t.schedule('user-1', flush);
    t.schedule('user-1', flush);
    await vi.advanceTimersByTimeAsync(5000);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('서로 다른 user 의 호출은 독립 — 각자 1 회 flush', async () => {
    const t = new StatusBroadcastThrottler();
    const f1 = vi.fn().mockResolvedValue(undefined);
    const f2 = vi.fn().mockResolvedValue(undefined);
    t.schedule('user-1', f1);
    t.schedule('user-2', f2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it('window 만료 후 동일 user 다시 호출 가능', async () => {
    const t = new StatusBroadcastThrottler();
    const flush = vi.fn().mockResolvedValue(undefined);
    t.schedule('user-1', flush);
    await vi.advanceTimersByTimeAsync(5000);
    expect(flush).toHaveBeenCalledTimes(1);
    t.schedule('user-1', flush);
    await vi.advanceTimersByTimeAsync(5000);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('cancel(userId) 로 pending 제거', async () => {
    const t = new StatusBroadcastThrottler();
    const flush = vi.fn().mockResolvedValue(undefined);
    t.schedule('user-1', flush);
    t.cancel('user-1');
    await vi.advanceTimersByTimeAsync(5000);
    expect(flush).not.toHaveBeenCalled();
  });

  it('flush 실패 (rejection) 가 process.unhandledRejection 안 일으킴', async () => {
    const t = new StatusBroadcastThrottler();
    const flush = vi.fn().mockRejectedValue(new Error('boom'));
    t.schedule('user-1', flush);
    await vi.advanceTimersByTimeAsync(5000);
    expect(flush).toHaveBeenCalledTimes(1);
    // no rethrow — Promise.resolve(flush()).catch(noop) 가 흡수.
  });
});
