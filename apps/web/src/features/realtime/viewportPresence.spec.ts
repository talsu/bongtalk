import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PRESENCE_VIEWPORT_SUBSCRIBE_CHUNK } from '@qufox/shared-types';
import {
  ViewportPresenceTracker,
  chunkUserIds,
  type ViewportPresenceCallbacks,
} from './viewportPresence';

/**
 * S27 (FR-P15): viewport presence collection — debounce, diff, chunk, reset.
 * Pure tracker driven by fake timers + a recording callbacks pair (no jsdom /
 * real IntersectionObserver needed). The React hook wires a real observer onto
 * this same core; its DOM behaviour is asserted at e2e.
 */

function makeRecorder(): {
  cb: ViewportPresenceCallbacks;
  subs: string[][];
  unsubs: string[][];
} {
  const subs: string[][] = [];
  const unsubs: string[][] = [];
  return {
    cb: {
      subscribe: (ids) => subs.push([...ids]),
      unsubscribe: (ids) => unsubs.push([...ids]),
    },
    subs,
    unsubs,
  };
}

describe('chunkUserIds (FR-P15)', () => {
  it('splits into max-100 chunks preserving order', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `u${i}`);
    const chunks = chunkUserIds(ids);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(PRESENCE_VIEWPORT_SUBSCRIBE_CHUNK);
    expect(chunks[1]).toHaveLength(PRESENCE_VIEWPORT_SUBSCRIBE_CHUNK);
    expect(chunks[2]).toHaveLength(50);
    expect(chunks.flat()).toEqual(ids);
  });

  it('returns no chunks for empty input', () => {
    expect(chunkUserIds([])).toEqual([]);
  });
});

describe('ViewportPresenceTracker (FR-P15)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces enter events into a single subscribe after the window', () => {
    const r = makeRecorder();
    const t = new ViewportPresenceTracker(r.cb);
    t.enter('a');
    t.enter('b');
    t.enter('c');
    // before debounce elapses, nothing fired.
    expect(r.subs).toEqual([]);
    vi.advanceTimersByTime(200);
    // one coalesced subscribe with all three.
    expect(r.subs).toHaveLength(1);
    expect(r.subs[0].sort()).toEqual(['a', 'b', 'c']);
  });

  it('only subscribes newly-visible ids (diff, never re-sends the whole set)', () => {
    const r = makeRecorder();
    const t = new ViewportPresenceTracker(r.cb);
    t.enter('a');
    t.enter('b');
    vi.advanceTimersByTime(200);
    expect(r.subs).toHaveLength(1);

    // c enters; a/b already subscribed → only c is sent.
    t.enter('c');
    vi.advanceTimersByTime(200);
    expect(r.subs).toHaveLength(2);
    expect(r.subs[1]).toEqual(['c']);
  });

  it('unsubscribes ids that leave the viewport', () => {
    const r = makeRecorder();
    const t = new ViewportPresenceTracker(r.cb);
    t.enter('a');
    t.enter('b');
    vi.advanceTimersByTime(200);

    t.leave('a');
    vi.advanceTimersByTime(200);
    expect(r.unsubs).toHaveLength(1);
    expect(r.unsubs[0]).toEqual(['a']);
    expect(t.subscribedIds().sort()).toEqual(['b']);
  });

  it('splits a large visible batch into 100-id subscribe chunks', () => {
    const r = makeRecorder();
    const t = new ViewportPresenceTracker(r.cb);
    for (let i = 0; i < 230; i += 1) t.enter(`u${i}`);
    vi.advanceTimersByTime(200);
    // 230 ids → 100 + 100 + 30 = three subscribe calls.
    expect(r.subs).toHaveLength(3);
    expect(r.subs[0]).toHaveLength(100);
    expect(r.subs[1]).toHaveLength(100);
    expect(r.subs[2]).toHaveLength(30);
  });

  it('reset() is immediate: cancels pending debounce + unsubscribes everything', () => {
    const r = makeRecorder();
    const t = new ViewportPresenceTracker(r.cb);
    t.enter('a');
    t.enter('b');
    vi.advanceTimersByTime(200);
    expect(t.subscribedIds().sort()).toEqual(['a', 'b']);

    // a pending enter that should be dropped by reset (channel switch mid-scroll).
    t.enter('c');
    t.reset();
    // reset unsubscribes the previously-subscribed a + b synchronously.
    expect(r.unsubs).toHaveLength(1);
    expect(r.unsubs[0].sort()).toEqual(['a', 'b']);
    expect(t.subscribedIds()).toEqual([]);

    // the dropped pending 'c' must NOT fire a late subscribe.
    const subsBefore = r.subs.length;
    vi.advanceTimersByTime(500);
    expect(r.subs.length).toBe(subsBefore);
  });
});
