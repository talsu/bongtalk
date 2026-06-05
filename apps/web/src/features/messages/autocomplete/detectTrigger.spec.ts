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

describe('detectTrigger (S79 / FR-SC-01) — / 슬래시 커맨드 트리거', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('줄 맨앞의 / 는 빈 query 로 즉시 트리거한다', () => {
    expect(detectTrigger('/', 1)).toEqual({ kind: 'slash', query: '', start: 0, end: 1 });
  });

  it('줄 맨앞의 /sh 를 트리거한다', () => {
    expect(detectTrigger('/sh', 3)).toEqual({ kind: 'slash', query: 'sh', start: 0, end: 3 });
  });

  it('개행 직후의 / 도 줄 맨앞으로 보고 트리거한다', () => {
    expect(detectTrigger('hi\n/me', 6)).toEqual({
      kind: 'slash',
      query: 'me',
      start: 3,
      end: 6,
    });
  });

  it('공백 직후의 / 는 트리거하지 않는다(슬래시는 줄 맨앞 전용 — Discord parity)', () => {
    // FR-SC-01: 슬래시 커맨드는 메시지 맨 앞에서만 의미가 있으므로, 텍스트 중간의
    // 공백 직후 / 는 트리거하지 않는다(예: "and /or" 같은 일반 문장).
    expect(detectTrigger('and /or', 7)).toBeNull();
  });

  it('URL 의 // 는 트리거하지 않는다(https:// 오작동 방지)', () => {
    expect(detectTrigger('see https://x', 13)).toBeNull();
    // 캐럿이 첫 / 직후여도 앞이 ':' 라 트리거 아님.
    expect(detectTrigger('https:/', 7)).toBeNull();
  });

  it('경로 표기 /var 가 단어 중간이면 트리거하지 않는다', () => {
    // "cd /var" — / 앞이 공백이지만 줄 맨앞이 아니므로 트리거 안 함.
    expect(detectTrigger('cd /var', 7)).toBeNull();
  });

  it('query 안에 공백이 들어가면 트리거하지 않는다(닫힌 토큰)', () => {
    expect(detectTrigger('/shrug hi', 9)).toBeNull();
  });
});
