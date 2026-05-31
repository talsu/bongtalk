import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextActiveIndex } from './listboxNav';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('nextActiveIndex (FR-RC06) — ↑↓ activedescendant 이동 (wrap)', () => {
  it('moves down and wraps from the last item to the first', () => {
    expect(nextActiveIndex(0, 'down', 3)).toBe(1);
    expect(nextActiveIndex(2, 'down', 3)).toBe(0);
  });

  it('moves up and wraps from the first item to the last', () => {
    expect(nextActiveIndex(1, 'up', 3)).toBe(0);
    expect(nextActiveIndex(0, 'up', 3)).toBe(2);
  });

  it('clamps to 0 when count is 1', () => {
    expect(nextActiveIndex(0, 'down', 1)).toBe(0);
    expect(nextActiveIndex(0, 'up', 1)).toBe(0);
  });

  it('returns -1 when there are no items', () => {
    expect(nextActiveIndex(0, 'down', 0)).toBe(-1);
    expect(nextActiveIndex(0, 'up', 0)).toBe(-1);
  });

  it('starts navigation from an unset (-1) active index', () => {
    expect(nextActiveIndex(-1, 'down', 3)).toBe(0);
    expect(nextActiveIndex(-1, 'up', 3)).toBe(2);
  });
});
