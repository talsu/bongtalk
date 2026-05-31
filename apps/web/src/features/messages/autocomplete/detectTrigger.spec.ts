import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectTrigger } from './detectTrigger';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('detectTrigger (FR-RC03/04/05) — 커서 기준 @/#/: 트리거 감지', () => {
  it('returns null when no trigger char precedes the caret', () => {
    expect(detectTrigger('hello world', 11)).toBeNull();
  });

  it('detects an @ mention trigger at the start of input', () => {
    const t = detectTrigger('@al', 3);
    expect(t).toEqual({ kind: 'mention', query: 'al', start: 0, end: 3 });
  });

  it('detects a # channel trigger mid-text after whitespace', () => {
    const t = detectTrigger('go to #gen', 10);
    expect(t).toEqual({ kind: 'channel', query: 'gen', start: 6, end: 10 });
  });

  it('detects an emoji trigger only with >= 2 query chars (FR-RC05)', () => {
    expect(detectTrigger('nice :t', 7)).toBeNull(); // 1 char → not yet
    const t = detectTrigger('nice :ta', 8);
    expect(t).toEqual({ kind: 'emoji', query: 'ta', start: 5, end: 8 });
  });

  it('does not trigger when the sigil is glued to a preceding word char (email-like)', () => {
    expect(detectTrigger('mail me at a@b', 14)).toBeNull();
  });

  it('allows the sigil at line start after a newline', () => {
    const t = detectTrigger('line1\n@bo', 9);
    expect(t).toEqual({ kind: 'mention', query: 'bo', start: 6, end: 9 });
  });

  it('stops the query at whitespace (closed token)', () => {
    expect(detectTrigger('@alice done', 11)).toBeNull();
  });

  it('supports an empty mention query (just the sigil) so the popup opens immediately', () => {
    const t = detectTrigger('hi @', 4);
    expect(t).toEqual({ kind: 'mention', query: '', start: 3, end: 4 });
  });

  it('uses the caret position, not the string end', () => {
    // caret sits right after "@al"; trailing " rest" is ignored.
    const t = detectTrigger('@al rest', 3);
    expect(t).toEqual({ kind: 'mention', query: 'al', start: 0, end: 3 });
  });

  it('rejects mention/channel queries with a space inside', () => {
    expect(detectTrigger('@al ice', 7)).toBeNull();
  });

  it('limits the query length to the max handle length (no runaway scan)', () => {
    const long = '@' + 'a'.repeat(60);
    expect(detectTrigger(long, long.length)).toBeNull();
  });
});
