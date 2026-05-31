import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SEQ_SENTINEL } from '@qufox/shared-types';
import { SeqTracker } from './seqTracker';

/**
 * S10 (FR-RT-06 / FR-RT-07): 채널별 seq hole 감지 순수 로직 단위 테스트.
 */
describe('SeqTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2025-01-01T00:00:00Z');
  });

  it('첫 관측은 기준선 수립 → ok (hole 아님)', () => {
    const t = new SeqTracker();
    expect(t.observe('c1', 5)).toEqual({ kind: 'ok' });
    expect(t.get('c1')).toBe(5);
  });

  it('직전 +1 연속이면 ok 로 전진', () => {
    const t = new SeqTracker();
    t.observe('c1', 1);
    expect(t.observe('c1', 2)).toEqual({ kind: 'ok' });
    expect(t.observe('c1', 3)).toEqual({ kind: 'ok' });
    expect(t.get('c1')).toBe(3);
  });

  it('불연속이면 hole 을 보고하고 새 seq 로 전진(같은 hole 재트리거 방지)', () => {
    const t = new SeqTracker();
    t.observe('c1', 1);
    expect(t.observe('c1', 4)).toEqual({ kind: 'hole', expected: 2, got: 4 });
    expect(t.get('c1')).toBe(4);
    // 다음 연속 이벤트는 ok.
    expect(t.observe('c1', 5)).toEqual({ kind: 'ok' });
  });

  it('직전 이하 seq(재전송/순서뒤집힘)는 duplicate — 전진하지 않음', () => {
    const t = new SeqTracker();
    t.observe('c1', 5);
    expect(t.observe('c1', 5)).toEqual({ kind: 'duplicate' });
    expect(t.observe('c1', 3)).toEqual({ kind: 'duplicate' });
    expect(t.get('c1')).toBe(5);
  });

  it('SEQ_SENTINEL(-1) 은 sentinel — hole 판정/단조성 갱신 모두 skip', () => {
    const t = new SeqTracker();
    t.observe('c1', 1);
    expect(t.observe('c1', SEQ_SENTINEL)).toEqual({ kind: 'sentinel' });
    // 추적값은 sentinel 로 오염되지 않음.
    expect(t.get('c1')).toBe(1);
    // sentinel 다음 정상 +1 은 여전히 ok.
    expect(t.observe('c1', 2)).toEqual({ kind: 'ok' });
  });

  it('채널은 독립적으로 추적', () => {
    const t = new SeqTracker();
    t.observe('c1', 10);
    t.observe('c2', 100);
    expect(t.observe('c1', 11)).toEqual({ kind: 'ok' });
    expect(t.observe('c2', 105)).toEqual({ kind: 'hole', expected: 101, got: 105 });
  });

  it('setBaseline 으로 join 스냅샷 seq 를 기준선으로 설정', () => {
    const t = new SeqTracker();
    t.setBaseline('c1', 42);
    expect(t.observe('c1', 43)).toEqual({ kind: 'ok' });
    expect(t.observe('c1', 45)).toEqual({ kind: 'hole', expected: 44, got: 45 });
  });

  it('setBaseline(SEQ_SENTINEL) 은 무시', () => {
    const t = new SeqTracker();
    t.setBaseline('c1', SEQ_SENTINEL);
    expect(t.get('c1')).toBeUndefined();
  });

  it('reset/clear', () => {
    const t = new SeqTracker();
    t.observe('c1', 1);
    t.observe('c2', 1);
    t.reset('c1');
    expect(t.get('c1')).toBeUndefined();
    expect(t.get('c2')).toBe(1);
    t.clear();
    expect(t.get('c2')).toBeUndefined();
  });
});
