import { describe, it, expect, beforeEach, vi } from 'vitest';
import { insertToken } from './insertToken';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('insertToken (FR-RC06) — 트리거 범위를 토큰으로 치환 + 캐럿 재배치', () => {
  it('replaces the @ trigger run with the mention token and a trailing space', () => {
    const r = insertToken({ text: 'hi @al', start: 3, end: 6, token: '@alice' });
    expect(r.text).toBe('hi @alice ');
    expect(r.caret).toBe('hi @alice '.length);
  });

  it('replaces a # trigger and preserves the text after the caret', () => {
    // end=7 is right after "gen"; the remaining " now" already starts with a
    // space, so no duplicate space is inserted.
    const r = insertToken({ text: 'go #gen now', start: 3, end: 7, token: '#general' });
    expect(r.text).toBe('go #general now');
    expect(r.caret).toBe('go #general'.length);
  });

  it('replaces a : emoji trigger with the glyph (no trailing colon kept)', () => {
    const r = insertToken({ text: 'nice :ta', start: 5, end: 8, token: '🎉' });
    expect(r.text).toBe('nice 🎉 ');
    expect(r.caret).toBe('nice 🎉 '.length);
  });

  it('does not add a duplicate space when the next char is already a space', () => {
    const r = insertToken({ text: '@al ', start: 0, end: 3, token: '@alice' });
    expect(r.text).toBe('@alice ');
    expect(r.caret).toBe('@alice'.length);
  });
});
