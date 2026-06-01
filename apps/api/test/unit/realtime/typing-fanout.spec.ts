import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TypingFanout, type TypingFanoutDeps } from '../../../src/realtime/typing/typing-fanout';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const CH = 'channel-1';

/**
 * S32 (FR-RT-08): batch 타이머 + fanout rate-limit 의 결정적 검증.
 *
 * 실제 setInterval 대신 수동으로 발화하는 fake timer 를 주입해 batch 주기를
 * 결정적으로 흘립니다. now 도 주입해 sliding-window 를 결정적으로 만듭니다.
 */
function harness(currentTypers?: (ch: string) => Promise<string[]>) {
  const batch: Array<{ channelId: string; userIds: string[] }> = [];
  const update: Array<{ channelId: string; userIds: string[] }> = [];
  // fake timer: 등록된 콜백을 fire() 로 수동 발화.
  let timerCb: (() => void) | null = null;
  let cleared = false;
  let now = 1_000_000;

  const deps: TypingFanoutDeps = {
    now: () => now,
    setTimer: (fn) => {
      timerCb = fn;
      cleared = false;
      return { id: 1 };
    },
    clearTimer: () => {
      cleared = true;
      timerCb = null;
    },
    emitBatch: (channelId, userIds) => batch.push({ channelId, userIds: [...userIds] }),
    emitUpdate: (channelId, userIds) => update.push({ channelId, userIds: [...userIds] }),
    currentTypers: currentTypers ?? (async () => []),
  };
  const fanout = new TypingFanout(deps);
  return {
    fanout,
    batch,
    update,
    fire: () => {
      if (timerCb) timerCb();
    },
    isCleared: () => cleared,
    setNow: (n: number) => (now = n),
  };
}

describe('TypingFanout batch 타이머 (FR-RT-08)', () => {
  it('인원 < 3 이면 단건 update, batch 모드 아님', () => {
    const h = harness();
    h.fanout.onTypersChanged(CH, ['a']);
    h.fanout.onTypersChanged(CH, ['a', 'b']);
    expect(h.fanout.isBatching(CH)).toBe(false);
    expect(h.update.map((u) => u.userIds)).toEqual([['a'], ['a', 'b']]);
    expect(h.batch).toEqual([]);
  });

  it('인원 ≥ 3 진입 시 즉시 첫 snapshot batch + batch 모드 ON', () => {
    const h = harness();
    h.fanout.onTypersChanged(CH, ['a', 'b', 'c']);
    expect(h.fanout.isBatching(CH)).toBe(true);
    expect(h.batch).toEqual([{ channelId: CH, userIds: ['a', 'b', 'c'] }]);
    // batch 진입 시 단건 update 는 보내지 않음.
    expect(h.update).toEqual([]);
  });

  it('batch 주기 tick 은 최신 snapshot 을 full-replace emit', async () => {
    const typers = { v: ['a', 'b', 'c', 'd'] };
    const h = harness(async () => typers.v);
    h.fanout.onTypersChanged(CH, ['a', 'b', 'c']); // 진입 snapshot
    // 다음 tick: typer 가 4명으로 늘어난 최신 snapshot.
    h.fire();
    await Promise.resolve();
    expect(h.batch[h.batch.length - 1]).toEqual({ channelId: CH, userIds: ['a', 'b', 'c', 'd'] });
  });

  it('batch tick 에서 3명 미만으로 줄면 타이머 clear + 단건 update 전환', async () => {
    const typers = { v: ['a', 'b'] };
    const h = harness(async () => typers.v);
    h.fanout.onTypersChanged(CH, ['a', 'b', 'c']); // batch 진입
    expect(h.fanout.isBatching(CH)).toBe(true);
    h.fire();
    await Promise.resolve();
    expect(h.fanout.isBatching(CH)).toBe(false);
    expect(h.isCleared()).toBe(true);
    // 마지막 단건 update 가 줄어든 집합을 반영.
    expect(h.update[h.update.length - 1]).toEqual({ channelId: CH, userIds: ['a', 'b'] });
  });

  it('onTypersChanged 가 3명 미만으로 직접 줄면 타이머 clear + 단건 전환', () => {
    const h = harness();
    h.fanout.onTypersChanged(CH, ['a', 'b', 'c']); // batch 진입
    h.fanout.onTypersChanged(CH, ['a']); // 줄어듦
    expect(h.fanout.isBatching(CH)).toBe(false);
    expect(h.isCleared()).toBe(true);
    expect(h.update[h.update.length - 1]).toEqual({ channelId: CH, userIds: ['a'] });
  });

  it('0명이면 빈 snapshot 으로 clear emit (인디케이터 해제)', () => {
    const h = harness();
    h.fanout.onTypersChanged(CH, ['a', 'b', 'c']); // batch
    h.fanout.onTypersChanged(CH, []); // 전원 stop
    expect(h.fanout.isBatching(CH)).toBe(false);
    expect(h.update[h.update.length - 1]).toEqual({ channelId: CH, userIds: [] });
  });
});

describe('TypingFanout fanout rate-limit ≤10/s (FR-RT-08)', () => {
  it('초당 10건까지 emit, 11번째는 drop', () => {
    const h = harness();
    // 같은 ms 안에서 12회 단건 update 시도(1~2명, batch 미진입).
    for (let i = 0; i < 12; i++) {
      h.fanout.onTypersChanged(CH, [`u${i % 2}`]);
    }
    expect(h.update.length).toBe(10);
  });

  it('1초 창이 지나면 다시 emit 허용', () => {
    const h = harness();
    for (let i = 0; i < 12; i++) h.fanout.onTypersChanged(CH, ['a']);
    expect(h.update.length).toBe(10);
    // 1초 경과 → window 비워짐.
    h.setNow(1_001_001);
    h.fanout.onTypersChanged(CH, ['a']);
    expect(h.update.length).toBe(11);
  });

  it('clear(0명) emit 은 rate-limit 우회 — 인디케이터 stuck 방지', () => {
    const h = harness();
    for (let i = 0; i < 12; i++) h.fanout.onTypersChanged(CH, ['a']); // window 소진
    expect(h.update.length).toBe(10);
    h.fanout.onTypersChanged(CH, []); // clear 는 항상 통과
    expect(h.update[h.update.length - 1]).toEqual({ channelId: CH, userIds: [] });
    expect(h.update.length).toBe(11);
  });
});
