import { describe, expect, it } from 'vitest';
import {
  wrapSelection,
  wrapSelectionPerLine,
  matchFormatShortcut,
  FORMAT_MARKERS,
} from './formatWrap';

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

  it('code block 이 줄 시작이 아닐 때 여는 펜스 앞에 \\n 을 선행하면 펜스가 줄 시작에 온다', () => {
    // applyFormat 의 codeBlock 분기는 직전 문자가 개행이 아니면 before 앞에 \n 을 붙인다.
    // (parser FENCE_RE `^```…$` 의 줄 시작 앵커를 만족시키기 위함.) 여기선 before 에 선행 \n 을
    // 합성한 형태가 'foo' 뒤에서 여는 펜스를 줄 시작에 두는지 검증한다.
    const before = `\n${FORMAT_MARKERS.codeBlock.before}`;
    const after = FORMAT_MARKERS.codeBlock.after;
    const r = wrapSelection({ text: 'foo bar', start: 4, end: 7, before, after });
    expect(r.text).toBe('foo \n```\nbar\n```');
    // 여는 펜스(```)가 개행 직후(줄 시작)에 위치한다.
    expect(r.text.indexOf('```')).toBe(r.text.indexOf('\n```') + 1);
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

describe('wrapSelectionPerLine', () => {
  it('단일 줄 선택은 wrapSelection 과 동일하게 한 번만 감싼다', () => {
    const r = wrapSelectionPerLine({
      text: 'hello world',
      start: 6,
      end: 11,
      ...FORMAT_MARKERS.bold,
    });
    expect(r.text).toBe('hello **world**');
    expect(r.text.slice(r.newStart, r.newEnd)).toBe('world');
  });

  it('멀티라인 선택은 각 비어있지 않은 줄을 개별 래핑한다(인라인 마커 `\\n` 미마감 회피)', () => {
    // 'a\nb' 를 bold(**) per-line 래핑 → '**a**\n**b**' (한 번 감싸면 '**a\nb**' 리터럴).
    const r = wrapSelectionPerLine({ text: 'a\nb', start: 0, end: 3, ...FORMAT_MARKERS.bold });
    expect(r.text).toBe('**a**\n**b**');
    // selection 은 치환된 전체 영역.
    expect(r.text.slice(r.newStart, r.newEnd)).toBe('**a**\n**b**');
    expect(r.newStart).toBe(0);
    expect(r.newEnd).toBe('**a**\n**b**'.length);
  });

  it('멀티라인에서 빈 줄·공백전용 줄은 래핑하지 않고 그대로 둔다', () => {
    // 'a\n\nb' → 가운데 빈 줄은 마커를 붙이지 않는다.
    const r = wrapSelectionPerLine({ text: 'a\n\nb', start: 0, end: 4, ...FORMAT_MARKERS.italic });
    expect(r.text).toBe('_a_\n\n_b_');
  });

  it('멀티라인 strike/code 도 줄 단위로 감싼다', () => {
    expect(
      wrapSelectionPerLine({ text: 'x\ny', start: 0, end: 3, ...FORMAT_MARKERS.strike }).text,
    ).toBe('~~x~~\n~~y~~');
    expect(
      wrapSelectionPerLine({ text: 'x\ny', start: 0, end: 3, ...FORMAT_MARKERS.code }).text,
    ).toBe('`x`\n`y`');
  });

  it('선택 앞뒤 컨텍스트를 보존하며 멀티라인 줄만 치환한다', () => {
    // 'pre a\nb post' 에서 'a\nb'(인덱스 4~7)만 per-line bold.
    const text = 'pre a\nb post';
    const start = 4;
    const end = 7; // 'a\nb'
    const r = wrapSelectionPerLine({ text, start, end, ...FORMAT_MARKERS.bold });
    expect(r.text).toBe('pre **a**\n**b** post');
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
