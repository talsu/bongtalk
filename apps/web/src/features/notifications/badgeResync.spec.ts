import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadgeResyncController, type BadgeResyncResult } from './badgeResync';

/**
 * S47 (FR-MN-20): 배지 재동기화 — debounce 500ms · inflight dedup · polling 미사용.
 */
describe('BadgeResyncController (S47 · FR-MN-20)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const emptyResult: BadgeResyncResult = { workspaces: [] };

  it('debounce 윈도(500ms) 안의 연속 트리거는 1회만 fetch 한다', async () => {
    const fetcher = vi.fn().mockResolvedValue(emptyResult);
    const onResult = vi.fn();
    const ctrl = new BadgeResyncController({ fetcher, onResult });

    // visibilitychange + reconnect 가 거의 동시에 발생.
    ctrl.request();
    ctrl.request();
    ctrl.request();
    expect(fetcher).not.toHaveBeenCalled(); // 아직 debounce 윈도 안.

    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('fetch 진행 중 다시 윈도가 만료돼도 inflight 면 중복 호출하지 않는다', async () => {
    let resolveFetch: (v: BadgeResyncResult) => void = () => {};
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<BadgeResyncResult>((res) => {
          resolveFetch = res;
        }),
    );
    const onResult = vi.fn();
    const ctrl = new BadgeResyncController({ fetcher, onResult });

    ctrl.request();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(1); // 1번째 fetch 시작(미완).

    // 진행 중 두 번째 트리거 → debounce 만료 시점에 inflight 라 run 이 즉시 return.
    ctrl.request();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(1); // dedup — 여전히 1.

    // 첫 fetch 완료 후의 새 트리거는 정상 호출.
    resolveFetch(emptyResult);
    await vi.runAllTimersAsync();
    ctrl.request();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('30초 polling 타이머를 등록하지 않는다(트리거 없으면 fetch 0)', async () => {
    const fetcher = vi.fn().mockResolvedValue(emptyResult);
    const ctrl = new BadgeResyncController({ fetcher, onResult: vi.fn() });

    // 트리거 없이 시간만 흘려도(30초 이상) fetch 가 일어나면 안 된다.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).not.toHaveBeenCalled();
    ctrl.dispose();
  });

  it('fetch 실패는 비-치명(throw 없음) — onResult 미호출', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network'));
    const onResult = vi.fn();
    const ctrl = new BadgeResyncController({ fetcher, onResult });
    ctrl.request();
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
  });
});
