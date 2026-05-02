import { describe, it, expect } from 'vitest';
import { takeAnchorSnapshot, restoreAnchorScrollTop, isNearBottom } from './messageAnchor';

/**
 * task-043 B-1 anchor unit tests. Covers the snapshot/restore round-
 * trip + edge cases the virtualizer-driven layout effect relies on.
 */

describe('takeAnchorSnapshot (task-043 B-1)', () => {
  it('returns null when the list is empty', () => {
    expect(takeAnchorSnapshot({ scrollTop: 0, virtualItems: [], messageIds: [] })).toBeNull();
  });

  it('returns null when virtualItems is empty', () => {
    expect(
      takeAnchorSnapshot({ scrollTop: 200, virtualItems: [], messageIds: ['a', 'b'] }),
    ).toBeNull();
  });

  it('captures the top virtualItem id and in-row offset', () => {
    const snap = takeAnchorSnapshot({
      scrollTop: 720,
      virtualItems: [
        { index: 10, start: 700 },
        { index: 11, start: 770 },
      ],
      messageIds: Array.from({ length: 50 }, (_, i) => `m-${i}`),
    });
    expect(snap).toEqual({ messageId: 'm-10', offsetWithinRow: 20 });
  });

  it('handles negative offset gracefully when scrollTop precedes virtualItem.start', () => {
    const snap = takeAnchorSnapshot({
      scrollTop: 100,
      virtualItems: [{ index: 5, start: 150 }],
      messageIds: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(snap?.offsetWithinRow).toBe(-50);
  });
});

describe('restoreAnchorScrollTop (task-043 B-1)', () => {
  it('returns null when the anchored message disappeared from the list', () => {
    const result = restoreAnchorScrollTop({
      snapshot: { messageId: 'gone', offsetWithinRow: 30 },
      messageIds: ['a', 'b'],
      startForIndex: () => 0,
    });
    expect(result).toBeNull();
  });

  it('returns null when the virtualizer cannot resolve a start for the new index', () => {
    const result = restoreAnchorScrollTop({
      snapshot: { messageId: 'a', offsetWithinRow: 30 },
      messageIds: ['a', 'b'],
      startForIndex: () => undefined,
    });
    expect(result).toBeNull();
  });

  it('reproduces scrollTop = newStart + offsetWithinRow', () => {
    const result = restoreAnchorScrollTop({
      snapshot: { messageId: 'm-10', offsetWithinRow: 20 },
      messageIds: Array.from({ length: 100 }, (_, i) => `m-${i - 50}`),
      // After a 50-message prepend, m-10 sits at index 60 with start=4200.
      startForIndex: (i) => (i === 60 ? 4200 : 0),
    });
    expect(result).toBe(4220);
  });

  it('round-trips through snapshot/restore without drift (5px tolerance)', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `m-${i}`);
    const snap = takeAnchorSnapshot({
      scrollTop: 1234,
      virtualItems: [{ index: 17, start: 1200 }],
      messageIds: ids,
    });
    expect(snap).not.toBeNull();
    // Imagine 50 older messages prepended; m-17 now lives at index 67.
    const newIds = [...Array.from({ length: 50 }, (_, i) => `older-${i}`), ...ids];
    const restored = restoreAnchorScrollTop({
      snapshot: snap!,
      messageIds: newIds,
      // Caller is responsible for the post-prepend start; we hand back
      // the canonical "old start + 50 rows × 64px estimate" math.
      startForIndex: (i) => (i === 67 ? 1200 + 50 * 64 : 0),
    });
    expect(restored).not.toBeNull();
    // Δ from old scrollTop (1234) → new scrollTop should equal the
    // weight of 50 prepended rows (3200). Diff stays within the
    // task-043 5px tolerance.
    expect(Math.abs(restored! - 1234 - 50 * 64)).toBeLessThanOrEqual(5);
  });
});

describe('isNearBottom (task-043 B-2 helper)', () => {
  it('exact bottom returns true', () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it('within default 100px slack returns true', () => {
    expect(isNearBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it('outside 100px slack returns false', () => {
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it('honours a custom slack', () => {
    expect(
      isNearBottom({
        scrollTop: 700,
        scrollHeight: 1000,
        clientHeight: 100,
        slack: 250,
      }),
    ).toBe(true);
  });
});
