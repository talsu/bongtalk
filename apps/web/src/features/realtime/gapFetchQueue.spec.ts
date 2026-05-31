import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GapFetchQueue } from './gapFetchQueue';

/**
 * S10 (FR-RT-23): gap-fetch 동시성 상한 FIFO 큐 단위 테스트.
 */

/** 수동 제어 가능한 deferred — 실행 순서/동시성 관찰용. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('GapFetchQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2025-01-01T00:00:00Z');
  });

  it('동시 실행은 concurrency 상한을 넘지 않고 초과분은 FIFO 대기', async () => {
    const q = new GapFetchQueue(2);
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();

    const enqueue = (id: string): Promise<void> => {
      const g = deferred();
      gates.set(id, g);
      return q.enqueue(id, async () => {
        order.push(`start:${id}`);
        await g.promise;
        order.push(`end:${id}`);
      });
    };

    const pA = enqueue('a');
    const pB = enqueue('b');
    const pC = enqueue('c');
    const pD = enqueue('d');

    // run 들은 마이크로태스크에서 시작 — flush.
    await Promise.resolve();
    await Promise.resolve();

    // 상한 2 → a, b 만 실행, c, d 는 대기.
    expect(q.activeCount).toBe(2);
    expect(q.pendingCount).toBe(2);
    expect(order).toEqual(['start:a', 'start:b']);

    // a 완료 → c 가 FIFO 로 진입.
    gates.get('a')!.resolve();
    await pA;
    await Promise.resolve();
    expect(order).toContain('start:c');
    expect(order).not.toContain('start:d');

    // b 완료 → d 진입.
    gates.get('b')!.resolve();
    await pB;
    await Promise.resolve();
    expect(order).toContain('start:d');

    gates.get('c')!.resolve();
    gates.get('d')!.resolve();
    await Promise.all([pC, pD]);
    expect(q.activeCount).toBe(0);
    expect(q.pendingCount).toBe(0);
  });

  it('같은 channelId 중복 enqueue 는 동일 promise 공유(중복 실행 방지)', async () => {
    const q = new GapFetchQueue(5);
    let runs = 0;
    const g = deferred();
    const run = async (): Promise<void> => {
      runs += 1;
      await g.promise;
    };
    const p1 = q.enqueue('same', run);
    const p2 = q.enqueue('same', run);
    expect(p1).toBe(p2);
    await Promise.resolve();
    expect(runs).toBe(1);
    g.resolve();
    await p1;
  });

  it('작업 실패는 해당 enqueue promise 를 reject 하고 슬롯을 비워 다음 작업 진입', async () => {
    const q = new GapFetchQueue(1);
    const pFail = q.enqueue('x', async () => {
      throw new Error('boom');
    });
    let okRan = false;
    const pOk = q.enqueue('y', async () => {
      okRan = true;
    });
    await expect(pFail).rejects.toThrow('boom');
    await pOk;
    expect(okRan).toBe(true);
    expect(q.activeCount).toBe(0);
  });

  it('완료된 channelId 는 재enqueue 가능(inflight 추적 해제)', async () => {
    const q = new GapFetchQueue(5);
    let runs = 0;
    await q.enqueue('z', async () => {
      runs += 1;
    });
    await q.enqueue('z', async () => {
      runs += 1;
    });
    expect(runs).toBe(2);
  });
});
