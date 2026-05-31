import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SeqTracker } from './seqTracker';
import {
  setActiveSeqTracker,
  clearActiveSeqTracker,
  resetSeqForChannel,
} from './seqTrackerRegistry';

/**
 * S10 fix-forward (FIX #5): LRU evict 가 활성 SeqTracker 의 채널을 reset 할 수
 * 있게 하는 레지스트리 순수 로직 테스트.
 */
describe('seqTrackerRegistry', () => {
  beforeEach(() => {
    vi.setSystemTime('2025-01-01T00:00:00Z');
    setActiveSeqTracker(null);
  });

  it('resetSeqForChannel 가 활성 tracker 의 해당 채널만 reset', () => {
    const t = new SeqTracker();
    t.observe('c1', 5);
    t.observe('c2', 9);
    setActiveSeqTracker(t);

    resetSeqForChannel('c1');
    expect(t.get('c1')).toBeUndefined();
    expect(t.get('c2')).toBe(9);
  });

  it('활성 tracker 미등록 시 resetSeqForChannel 은 no-op(throw 없음)', () => {
    expect(() => resetSeqForChannel('cX')).not.toThrow();
  });

  it('clearActiveSeqTracker 는 같은 인스턴스일 때만 해제(소켓 교체 레이스 방어)', () => {
    const a = new SeqTracker();
    const b = new SeqTracker();
    a.observe('c1', 1);
    b.observe('c1', 1);

    setActiveSeqTracker(a);
    // b 가 detach 돼도 활성은 여전히 a → a 가 reset 되어야 함.
    clearActiveSeqTracker(b);
    resetSeqForChannel('c1');
    expect(a.get('c1')).toBeUndefined();

    // 이제 a 가 detach → 활성 없음 → 이후 reset 은 no-op.
    setActiveSeqTracker(a);
    clearActiveSeqTracker(a);
    a.observe('c2', 7);
    resetSeqForChannel('c2');
    expect(a.get('c2')).toBe(7);
  });
});
