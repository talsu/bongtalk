/**
 * Task-014-A / task-011-follow-7 closure: unit coverage for the mention
 * toast throttle. Uses `vi.useFakeTimers` so the 1-second refill cadence
 * + the 1-second collapsed-toast timer are deterministic. Mirrors the
 * 005 fake-clock pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MentionThrottle } from './dispatcher';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MentionThrottle', () => {
  it('tryConsume: capacity-5 bucket drains then refuses', () => {
    const t = new MentionThrottle();
    for (let i = 0; i < 5; i++) expect(t.tryConsume()).toBe(true);
    // 6th call in the same millisecond — bucket empty, refill<1 token.
    expect(t.tryConsume()).toBe(false);
  });

  it('refills at 5 tokens/second — capped at 5', () => {
    const t = new MentionThrottle();
    for (let i = 0; i < 5; i++) t.tryConsume();
    expect(t.tryConsume()).toBe(false);
    // 1 second → +5 tokens → 5 more consumes succeed, 6th fails.
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 5; i++) expect(t.tryConsume()).toBe(true);
    expect(t.tryConsume()).toBe(false);
    // 10 seconds later still caps at 5 (no over-fill).
    vi.advanceTimersByTime(10_000);
    for (let i = 0; i < 5; i++) expect(t.tryConsume()).toBe(true);
    expect(t.tryConsume()).toBe(false);
  });

  it('collapseOne aggregates over-budget mentions into a single 1s-delayed toast', () => {
    const t = new MentionThrottle();
    const emit = vi.fn();
    // Drain the bucket first so collapseOne actually matters.
    for (let i = 0; i < 5; i++) t.tryConsume();
    // 7 over-budget events arrive over the next 300ms.
    for (let i = 0; i < 7; i++) {
      t.collapseOne(emit);
      vi.advanceTimersByTime(40);
    }
    // Before the 1-second window elapses, nothing has fired yet.
    expect(emit).not.toHaveBeenCalled();
    // Advance past the 1-second mark from the FIRST collapseOne call.
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(7);
  });

  it('collapseOne rearms after the timer fires — second batch emits separately', () => {
    const t = new MentionThrottle();
    const emit = vi.fn();
    t.collapseOne(emit);
    t.collapseOne(emit);
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledWith(2);
    // Fresh batch after the first timer ran out.
    t.collapseOne(emit);
    t.collapseOne(emit);
    t.collapseOne(emit);
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][0]).toBe(3);
  });
});
