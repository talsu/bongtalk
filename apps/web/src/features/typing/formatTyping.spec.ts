import { describe, it, expect } from 'vitest';
import { formatTypingLabel } from './formatTyping';

const VIEWER = 'viewer';
const A = 'aaaa';
const B = 'bbbb';
const C = 'cccc';
const D = 'dddd';

function names(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

describe('formatTypingLabel (task-018-F)', () => {
  it('returns null when nobody is typing', () => {
    expect(formatTypingLabel([], VIEWER, names([]))).toBeNull();
  });

  it('excludes the viewer from the set', () => {
    expect(formatTypingLabel([VIEWER], VIEWER, names([[VIEWER, 'me']]))).toBeNull();
  });

  it('single user → "<name> 입력 중…"', () => {
    expect(formatTypingLabel([A], VIEWER, names([[A, 'pm_choi']]))).toBe('pm_choi 입력 중…');
  });

  it('two users → "<a>, <b> 입력 중…"', () => {
    expect(
      formatTypingLabel(
        [A, B],
        VIEWER,
        names([
          [A, 'user_a'],
          [B, 'user_b'],
        ]),
      ),
    ).toBe('user_a, user_b 입력 중…');
  });

  it('three users → "<a>, <b> 외 1명 입력 중…"', () => {
    expect(
      formatTypingLabel(
        [A, B, C],
        VIEWER,
        names([
          [A, 'user_a'],
          [B, 'user_b'],
          [C, 'user_c'],
        ]),
      ),
    ).toBe('user_a, user_b 외 1명 입력 중…');
  });

  it('four users → "<a>, <b> 외 2명 입력 중…"', () => {
    expect(
      formatTypingLabel(
        [A, B, C, D],
        VIEWER,
        names([
          [A, 'user_a'],
          [B, 'user_b'],
          [C, 'user_c'],
          [D, 'user_d'],
        ]),
      ),
    ).toBe('user_a, user_b 외 2명 입력 중…');
  });

  it('unknown userId falls back to "익명"', () => {
    expect(formatTypingLabel(['ghost'], VIEWER, names([]))).toBe('익명 입력 중…');
  });
});
