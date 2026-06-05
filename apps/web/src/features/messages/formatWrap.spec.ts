import { describe, expect, it } from 'vitest';
import { wrapSelection, matchFormatShortcut, FORMAT_MARKERS } from './formatWrap';

/** S83a (FR-KS-05): 마크다운 래핑 + 단축키 매칭 순수 함수 테스트. */

describe('wrapSelection', () => {
  it('선택 텍스트를 before/after 로 감싸고 selection 을 내용 위로 유지한다', () => {
    const r = wrapSelection({ text: 'hello world', start: 6, end: 11, before: '**', after: '**' });
    expect(r.text).toBe('hello **world**');
    // 'world' 가 마커 안쪽에 그대로 선택 유지(before 길이만큼 뒤로).
    expect(r.text.slice(r.newStart, r.newEnd)).toBe('world');
    expect(r.newStart).toBe(8);
    expect(r.newEnd).toBe(13);
  });

  it('선택이 없으면 마커만 삽입하고 커서를 마커 사이에 둔다', () => {
    const r = wrapSelection({ text: 'ab', start: 1, end: 1, before: '_', after: '_' });
    expect(r.text).toBe('a__b');
    expect(r.newStart).toBe(r.newEnd); // 커서(빈 선택)
    expect(r.newStart).toBe(2); // 'a' + '_' 사이
  });

  it('italic 은 `_` 마커로 감싼다(파서 정합 — `*` 아님)', () => {
    const { before, after } = FORMAT_MARKERS.italic;
    const r = wrapSelection({ text: 'x', start: 0, end: 1, before, after });
    expect(r.text).toBe('_x_');
  });

  it('strike(~~)·code(`)·bold(**) 마커', () => {
    expect(wrapSelection({ text: 'x', start: 0, end: 1, ...FORMAT_MARKERS.strike }).text).toBe(
      '~~x~~',
    );
    expect(wrapSelection({ text: 'x', start: 0, end: 1, ...FORMAT_MARKERS.code }).text).toBe('`x`');
    expect(wrapSelection({ text: 'x', start: 0, end: 1, ...FORMAT_MARKERS.bold }).text).toBe(
      '**x**',
    );
  });

  it('code block 은 앞뒤 개행을 포함해 감싼다', () => {
    const { before, after } = FORMAT_MARKERS.codeBlock;
    const r = wrapSelection({ text: 'const x = 1', start: 0, end: 11, before, after });
    expect(r.text).toBe('```\nconst x = 1\n```');
    expect(r.text.slice(r.newStart, r.newEnd)).toBe('const x = 1');
  });

  it('경계: 빈 텍스트·범위 역전·범위 초과를 클램프한다', () => {
    expect(wrapSelection({ text: '', start: 0, end: 0, before: '`', after: '`' }).text).toBe('``');
    // start>end 역전 → 정규화.
    const rev = wrapSelection({ text: 'abc', start: 3, end: 0, before: '*', after: '*' });
    expect(rev.text).toBe('*abc*');
    // 범위 초과 클램프.
    const over = wrapSelection({ text: 'ab', start: 0, end: 99, before: '`', after: '`' });
    expect(over.text).toBe('`ab`');
  });
});

describe('matchFormatShortcut', () => {
  const base = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  it('Ctrl/Cmd+B → bold, +I → italic', () => {
    expect(matchFormatShortcut({ ...base, key: 'b', ctrlKey: true })).toBe('bold');
    expect(matchFormatShortcut({ ...base, key: 'i', metaKey: true })).toBe('italic');
  });
  it('Ctrl/Cmd+Shift+X → strike, +C → code, +Enter → codeBlock', () => {
    expect(matchFormatShortcut({ ...base, key: 'x', ctrlKey: true, shiftKey: true })).toBe(
      'strike',
    );
    expect(matchFormatShortcut({ ...base, key: 'c', metaKey: true, shiftKey: true })).toBe('code');
    expect(matchFormatShortcut({ ...base, key: 'Enter', ctrlKey: true, shiftKey: true })).toBe(
      'codeBlock',
    );
  });
  it('수식키 없거나 Alt 동반·미매칭 키는 null', () => {
    expect(matchFormatShortcut({ ...base, key: 'b' })).toBeNull();
    expect(matchFormatShortcut({ ...base, key: 'b', ctrlKey: true, altKey: true })).toBeNull();
    expect(matchFormatShortcut({ ...base, key: 'z', ctrlKey: true })).toBeNull();
    // Shift 없는 Ctrl+X 는(잘라내기) 매칭 안 함.
    expect(matchFormatShortcut({ ...base, key: 'x', ctrlKey: true })).toBeNull();
  });
});
