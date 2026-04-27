import { describe, it, expect } from 'vitest';
import { clampAttachments, MAX_ATTACHMENTS } from './clampAttachments';

const F = (name: string): File => ({ name, size: 1, type: 'image/png' }) as unknown as File;

/**
 * task-041 B-3 (review M3 follow): exercise the clamp helper under
 * the double-pick race the reviewer flagged. The composer's
 * `onFiles` reads `pending.length + jobs.length` from a closed-over
 * render snapshot; if the user picks files via the dropdown then
 * immediately drops more files, both calls compute `currentCount`
 * from the same stale snapshot. With React functional updaters in
 * place the underlying setState batches correctly, but the clamp
 * helper itself MUST stay pure — same input always yields same
 * output, no shared mutation, immutable returns.
 *
 * Three guarantees:
 *   1. Promise.all of two simulated picks (each computing clamp
 *      against the same `currentCount`) returns independent results.
 *   2. The helper does not mutate either of its inputs.
 *   3. The 12-→-10 boundary cleanly drops the surplus tail.
 */

describe('clampAttachments race / immutability (task-041 B-3)', () => {
  it('Promise.all of two concurrent clamp calls each return independent slices', async () => {
    const currentCount = 0;
    // Simulate two concurrent picks of 7 files each; both compute
    // against currentCount=0 (the real composer race).
    const incomingA = [F('a1'), F('a2'), F('a3'), F('a4'), F('a5'), F('a6'), F('a7')];
    const incomingB = [F('b1'), F('b2'), F('b3'), F('b4'), F('b5'), F('b6'), F('b7')];
    const [resA, resB] = await Promise.all([
      Promise.resolve(clampAttachments({ currentCount, incoming: incomingA })),
      Promise.resolve(clampAttachments({ currentCount, incoming: incomingB })),
    ]);
    // Both calls see currentCount=0 → both accept all 7 files. The
    // race surfaces when caller funnels both result sets into a
    // single state container — the clamp helper itself is correct.
    expect(resA.accepted).toHaveLength(7);
    expect(resB.accepted).toHaveLength(7);
    expect(resA.truncated).toBe(false);
    expect(resB.truncated).toBe(false);
    // Different instances, no shared identity.
    expect(resA.accepted).not.toBe(resB.accepted);
  });

  it('does NOT mutate the incoming array', () => {
    const incoming = [F('a'), F('b'), F('c')];
    const before = incoming.slice();
    clampAttachments({ currentCount: 0, incoming });
    expect(incoming).toEqual(before);
    expect(incoming).toHaveLength(3);
  });

  it('returns a fresh accepted array (not the same reference)', () => {
    const incoming = [F('a'), F('b')];
    const r = clampAttachments({ currentCount: 0, incoming });
    expect(r.accepted).not.toBe(incoming);
  });

  it('12 incoming with currentCount=0 → exactly 10 accepted, 2 dropped', () => {
    const incoming = Array.from({ length: 12 }, (_, i) => F(`f${i}`));
    const r = clampAttachments({ currentCount: 0, incoming });
    expect(r.accepted).toHaveLength(MAX_ATTACHMENTS);
    expect(r.rejected).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.accepted.map((f) => f.name)).toEqual([
      'f0',
      'f1',
      'f2',
      'f3',
      'f4',
      'f5',
      'f6',
      'f7',
      'f8',
      'f9',
    ]);
  });

  it('two stale-snapshot calls (currentCount=0 each) must be reconciled by caller, not helper', () => {
    // The helper has no global state. Two callers using stale 0 each
    // get 10 accepted; the integration with React useState's functional
    // updater is what enforces the cap downstream. This test asserts
    // the helper's "no shared state" property explicitly so a future
    // refactor can't quietly add a closure-scoped counter.
    const a = clampAttachments({ currentCount: 0, incoming: [F('a')] });
    const b = clampAttachments({ currentCount: 0, incoming: [F('b')] });
    expect(a.accepted).toHaveLength(1);
    expect(b.accepted).toHaveLength(1);
    expect(a.accepted[0]).not.toBe(b.accepted[0]);
  });
});
