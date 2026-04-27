import { describe, it, expect } from 'vitest';
import { clampAttachments, MAX_ATTACHMENTS } from './clampAttachments';

const F = (name: string) => ({ name, size: 1, type: 'image/png' }) as unknown as File;

describe('clampAttachments (task-040 R4)', () => {
  it('passes through when count + incoming ≤ cap', () => {
    const r = clampAttachments({
      currentCount: 3,
      incoming: [F('a'), F('b'), F('c')],
    });
    expect(r.accepted).toHaveLength(3);
    expect(r.rejected).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it('truncates the tail when batch would overflow', () => {
    const r = clampAttachments({
      currentCount: 8,
      incoming: [F('a'), F('b'), F('c'), F('d')],
    });
    expect(r.accepted).toHaveLength(2);
    expect(r.accepted.map((f) => f.name)).toEqual(['a', 'b']);
    expect(r.rejected).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it('rejects all when already at cap', () => {
    const r = clampAttachments({
      currentCount: MAX_ATTACHMENTS,
      incoming: [F('a'), F('b')],
    });
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it('handles empty incoming gracefully (no truncation flag)', () => {
    const r = clampAttachments({ currentCount: MAX_ATTACHMENTS, incoming: [] });
    expect(r).toEqual({ accepted: [], rejected: 0, truncated: false });
  });

  it('exposes a 10-cap matching server zod schema', () => {
    expect(MAX_ATTACHMENTS).toBe(10);
  });

  it('boundary: cap exactly matches incoming when current is 0', () => {
    const incoming = Array.from({ length: 10 }, (_, i) => F(`a${i}`));
    const r = clampAttachments({ currentCount: 0, incoming });
    expect(r.accepted).toHaveLength(10);
    expect(r.truncated).toBe(false);
  });

  it('boundary: 11 incoming with 0 current → 10 accepted, 1 rejected', () => {
    const incoming = Array.from({ length: 11 }, (_, i) => F(`a${i}`));
    const r = clampAttachments({ currentCount: 0, incoming });
    expect(r.accepted).toHaveLength(10);
    expect(r.rejected).toBe(1);
    expect(r.truncated).toBe(true);
  });
});
