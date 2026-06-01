import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AckScheduler,
  isScrolledToBottom,
  SCROLL_BOTTOM_THRESHOLD_PX,
  type AckFlush,
} from './ackScheduler';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('isScrolledToBottom (FR-RS-02)', () => {
  it('임계(50px) 안이면 바닥으로 판정', () => {
    expect(isScrolledToBottom({ scrollTop: 951, scrollHeight: 1000, clientHeight: 0 })).toBe(true);
    expect(isScrolledToBottom({ scrollTop: 950, scrollHeight: 1000, clientHeight: 0 })).toBe(true);
  });
  it('임계 밖이면 바닥 아님', () => {
    expect(isScrolledToBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 0 })).toBe(false);
  });
  it('clientHeight 를 반영', () => {
    // scrollTop >= scrollHeight - clientHeight - 50
    expect(isScrolledToBottom({ scrollTop: 150, scrollHeight: 1000, clientHeight: 800 })).toBe(
      true,
    );
    expect(isScrolledToBottom({ scrollTop: 149, scrollHeight: 1000, clientHeight: 800 })).toBe(
      false,
    );
  });
  it('기본 임계치는 50px', () => {
    expect(SCROLL_BOTTOM_THRESHOLD_PX).toBe(50);
  });
});

describe('AckScheduler — 5초 디바운스 (FR-RS-02)', () => {
  it('scheduleDebounced 는 5초 뒤 한 번만 flush', () => {
    const flushes: AckFlush[] = [];
    const s = new AckScheduler({ onFlush: (f) => flushes.push(f) });
    s.scheduleDebounced('ch-1', 'm-1');
    expect(flushes).toHaveLength(0);
    vi.advanceTimersByTime(4999);
    expect(flushes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toMatchObject({ channelId: 'ch-1', lastReadMessageId: 'm-1' });
  });

  it('윈도우 안에서 다시 호출하면 타이머가 갱신되고 마지막 messageId 로 flush', () => {
    const flushes: AckFlush[] = [];
    const s = new AckScheduler({ onFlush: (f) => flushes.push(f) });
    s.scheduleDebounced('ch-1', 'm-1');
    vi.advanceTimersByTime(3000);
    s.scheduleDebounced('ch-1', 'm-2');
    vi.advanceTimersByTime(4999);
    expect(flushes).toHaveLength(0); // 갱신됐으니 아직
    vi.advanceTimersByTime(1);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].lastReadMessageId).toBe('m-2');
  });

  it('flush body 에 clientTimestamp(epoch millis) 를 싣는다', () => {
    const flushes: AckFlush[] = [];
    const s = new AckScheduler({ onFlush: (f) => flushes.push(f) });
    s.scheduleDebounced('ch-1', 'm-1');
    vi.advanceTimersByTime(5000);
    // fake 시계가 5초 진행했으므로 flush 시점 timestamp 도 +5s(epoch millis).
    expect(flushes[0].clientTimestamp).toBe(new Date('2025-01-01T00:00:05Z').getTime());
  });
});

describe('AckScheduler — 즉시 ACK (FR-RS-02 scroll-to-bottom)', () => {
  it('flushImmediate 는 디바운스 없이 즉시 flush', () => {
    const flushes: AckFlush[] = [];
    const s = new AckScheduler({ onFlush: (f) => flushes.push(f) });
    s.flushImmediate('ch-1', 'm-9');
    expect(flushes).toHaveLength(1);
    expect(flushes[0].lastReadMessageId).toBe('m-9');
  });

  it('flushImmediate 는 대기 중 디바운스 타이머를 취소', () => {
    const flushes: AckFlush[] = [];
    const s = new AckScheduler({ onFlush: (f) => flushes.push(f) });
    s.scheduleDebounced('ch-1', 'm-1');
    s.flushImmediate('ch-1', 'm-2');
    expect(flushes).toHaveLength(1);
    expect(flushes[0].lastReadMessageId).toBe('m-2');
    // 취소된 디바운스 타이머가 추가 flush 를 일으키면 안 됨.
    vi.advanceTimersByTime(10000);
    expect(flushes).toHaveLength(1);
  });
});

describe('AckScheduler — 중복 flush 차단', () => {
  it('동일 (채널, messageId) 재flush 는 생략', () => {
    const flushes: AckFlush[] = [];
    const s = new AckScheduler({ onFlush: (f) => flushes.push(f) });
    s.flushImmediate('ch-1', 'm-1');
    s.flushImmediate('ch-1', 'm-1');
    expect(flushes).toHaveLength(1);
  });

  it('messageId 가 진행하면 다시 flush', () => {
    const flushes: AckFlush[] = [];
    const s = new AckScheduler({ onFlush: (f) => flushes.push(f) });
    s.flushImmediate('ch-1', 'm-1');
    s.flushImmediate('ch-1', 'm-2');
    expect(flushes).toHaveLength(2);
  });

  it('cancel 후 flushNow 는 대기분이 없으면 무전송', () => {
    const flushes: AckFlush[] = [];
    const s = new AckScheduler({ onFlush: (f) => flushes.push(f) });
    s.scheduleDebounced('ch-1', 'm-1');
    s.cancel();
    s.flushNow();
    expect(flushes).toHaveLength(0);
  });
});
