import { describe, it, expect, beforeEach, vi } from 'vitest';
import { touchChannel } from './channelLruCache';

/**
 * S09 (FR-RT-22): 채널 메시지 목록 LRU 순서/eviction 순수 로직 단위 테스트.
 * 진입 순서 → eviction 대상이 "가장 오래 전 진입한 채널"인지 검증합니다.
 */
describe('touchChannel (FR-RT-22 LRU policy)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2025-01-01T00:00:00Z');
  });

  it('상한 미만이면 진입 채널을 tail 에 추가하고 evict 없음', () => {
    const r1 = touchChannel([], 'a', 3);
    expect(r1.order).toEqual(['a']);
    expect(r1.evicted).toEqual([]);
    const r2 = touchChannel(r1.order, 'b', 3);
    expect(r2.order).toEqual(['a', 'b']);
    expect(r2.evicted).toEqual([]);
  });

  it('이미 있던 채널 재진입 시 tail 로 recency 갱신(중복 없음)', () => {
    const order = ['a', 'b', 'c'];
    const r = touchChannel(order, 'a', 3);
    expect(r.order).toEqual(['b', 'c', 'a']);
    expect(r.evicted).toEqual([]);
  });

  it('상한 초과 시 가장 오래 전 진입한(head) 채널을 evict', () => {
    let order: string[] = [];
    for (const ch of ['a', 'b', 'c', 'd', 'e']) {
      order = touchChannel(order, ch, 5).order;
    }
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e']);
    // 6번째 distinct 채널 진입 → head 'a' evict.
    const r = touchChannel(order, 'f', 5);
    expect(r.evicted).toEqual(['a']);
    expect(r.order).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('재진입으로 recency 가 갱신된 채널은 evict 대상에서 제외', () => {
    // a,b,c,d,e 진입 후 a 재진입 → a 가 most-recent.
    let order: string[] = [];
    for (const ch of ['a', 'b', 'c', 'd', 'e']) {
      order = touchChannel(order, ch, 5).order;
    }
    order = touchChannel(order, 'a', 5).order; // a → tail
    expect(order).toEqual(['b', 'c', 'd', 'e', 'a']);
    // 새 채널 f 진입 → 이제 head 인 'b' 가 evict (a 아님).
    const r = touchChannel(order, 'f', 5);
    expect(r.evicted).toEqual(['b']);
    expect(r.order).toEqual(['c', 'd', 'e', 'a', 'f']);
  });

  it('maxSize 1 이면 직전 채널을 즉시 evict', () => {
    const r1 = touchChannel([], 'a', 1);
    expect(r1.order).toEqual(['a']);
    const r2 = touchChannel(r1.order, 'b', 1);
    expect(r2.evicted).toEqual(['a']);
    expect(r2.order).toEqual(['b']);
  });

  it('1 미만 maxSize 는 1 로 보정', () => {
    const r = touchChannel(['a'], 'b', 0);
    expect(r.order).toEqual(['b']);
    expect(r.evicted).toEqual(['a']);
  });

  it('방금 진입한 채널은 절대 evict 대상이 아니다', () => {
    let order: string[] = [];
    for (const ch of ['a', 'b', 'c']) order = touchChannel(order, ch, 3).order;
    const r = touchChannel(order, 'd', 3);
    expect(r.evicted).not.toContain('d');
    expect(r.order[r.order.length - 1]).toBe('d');
  });
});
