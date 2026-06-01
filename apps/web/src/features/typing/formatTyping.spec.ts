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

describe('formatTypingLabel (S32 · FR-RT-09)', () => {
  it('returns null when nobody is typing', () => {
    expect(formatTypingLabel([], VIEWER, names([]))).toBeNull();
  });

  it('excludes the viewer from the set', () => {
    expect(formatTypingLabel([VIEWER], VIEWER, names([[VIEWER, 'me']]))).toBeNull();
  });

  it('single user → "<name> 님이 입력 중…"', () => {
    expect(formatTypingLabel([A], VIEWER, names([[A, 'pm_choi']]))).toBe('pm_choi 님이 입력 중…');
  });

  it('two users → "<a>, <b> 님이 입력 중…"', () => {
    expect(
      formatTypingLabel(
        [A, B],
        VIEWER,
        names([
          [A, 'user_a'],
          [B, 'user_b'],
        ]),
      ),
    ).toBe('user_a, user_b 님이 입력 중…');
  });

  it('three users → "여러 명이 입력 중…" (이름 비노출, 고정 문구)', () => {
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
    ).toBe('여러 명이 입력 중…');
  });

  it('four users → "여러 명이 입력 중…" (≥3 동일 축약)', () => {
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
    ).toBe('여러 명이 입력 중…');
  });

  it('viewer 제외 후 2명 이하이면 이름을 보여준다(여러 명 아님)', () => {
    // 본인 포함 3명이지만 viewer 를 빼면 2명 → 이름 노출.
    expect(
      formatTypingLabel(
        [VIEWER, A, B],
        VIEWER,
        names([
          [A, 'user_a'],
          [B, 'user_b'],
        ]),
      ),
    ).toBe('user_a, user_b 님이 입력 중…');
  });

  it('unknown userId falls back to "익명"', () => {
    expect(formatTypingLabel(['ghost'], VIEWER, names([]))).toBe('익명 님이 입력 중…');
  });
});
