import { describe, expect, it } from 'vitest';
import {
  wrapSelection,
  wrapSelectionPerLine,
  matchFormatShortcut,
  FORMAT_MARKERS,
  prefixQuote,
  wrapLink,
  LINK_URL_PLACEHOLDER,
  shouldShowFormatToolbar,
  applyToolbarFormatToText,
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

describe('prefixQuote (S83c / FR-KS-10)', () => {
  it('단일 줄 선택 각 줄 앞에 `> ` prefix 를 붙인다', () => {
    const r = prefixQuote({ text: 'hello', start: 0, end: 5 });
    expect(r.text).toBe('> hello');
    // selection 은 치환된 줄 전체.
    expect(r.text.slice(r.newStart, r.newEnd)).toBe('> hello');
  });

  it('멀티라인 선택은 각 줄 앞에 `> ` 를 붙인다(per-line — 연속 blockquote 정합)', () => {
    const r = prefixQuote({ text: 'a\nb\nc', start: 0, end: 5 });
    expect(r.text).toBe('> a\n> b\n> c');
  });

  it('가운데 빈 줄도 `> ` 를 붙여 연속 blockquote 가 끊기지 않게 한다', () => {
    const r = prefixQuote({ text: 'a\n\nb', start: 0, end: 4 });
    expect(r.text).toBe('> a\n> \n> b');
  });

  it('줄 중간에서 시작/끝나는 선택도 그 줄 전체를 인용한다(줄 경계로 확장)', () => {
    // 'foo bar' 의 'o b'(2~5)만 선택해도 줄 전체에 prefix.
    const r = prefixQuote({ text: 'foo bar', start: 2, end: 5 });
    expect(r.text).toBe('> foo bar');
  });

  it('선택 앞뒤 줄은 보존하고 선택이 걸친 줄만 인용한다', () => {
    const text = 'pre\nmid\npost';
    // 'mid'(4~7)만 선택.
    const r = prefixQuote({ text, start: 4, end: 7 });
    expect(r.text).toBe('pre\n> mid\npost');
  });

  it('선택이 줄 끝 개행에서 끝나면 그 개행은 다음 줄 소속이라 포함하지 않는다', () => {
    // 'a\nb' 에서 'a\n'(0~2) 선택 → 'a' 줄만 인용.
    const r = prefixQuote({ text: 'a\nb', start: 0, end: 2 });
    expect(r.text).toBe('> a\nb');
  });

  it('빈 선택(caret)은 caret 이 있는 줄 시작에 `> ` 를 삽입한다', () => {
    const r = prefixQuote({ text: 'abc', start: 1, end: 1 });
    expect(r.text).toBe('> abc');
  });
});

describe('wrapLink (S83c / FR-KS-10)', () => {
  it('선택을 `[선택](url)` 로 감싸고 selection 을 url 플레이스홀더 위에 올린다', () => {
    const r = wrapLink({ text: 'qufox', start: 0, end: 5 });
    expect(r.text).toBe('[qufox](url)');
    // 다음 입력이 url 을 덮어쓰도록 'url' 위에 선택.
    expect(r.text.slice(r.newStart, r.newEnd)).toBe(LINK_URL_PLACEHOLDER);
  });

  it('빈 선택은 `[](url)` 를 삽입하고 url 플레이스홀더를 선택한다', () => {
    const r = wrapLink({ text: '', start: 0, end: 0 });
    expect(r.text).toBe('[](url)');
    expect(r.text.slice(r.newStart, r.newEnd)).toBe(LINK_URL_PLACEHOLDER);
  });

  it('앞뒤 컨텍스트를 보존하며 선택 범위만 링크로 감싼다', () => {
    const r = wrapLink({ text: 'see qufox here', start: 4, end: 9 });
    expect(r.text).toBe('see [qufox](url) here');
  });

  it('파서 MD_LINK_RE 와 정합 — label 개행 없음·url 공백/괄호 없음', () => {
    const r = wrapLink({ text: 'doc', start: 0, end: 3 });
    // [label](url) 형태: label='doc', url='url'.
    expect(r.text).toMatch(/^\[doc\]\(url\)$/);
  });
});

describe('shouldShowFormatToolbar (S83c / FR-KS-10)', () => {
  it('비어있지 않은 선택 + 자동완성 닫힘이면 표시한다', () => {
    expect(
      shouldShowFormatToolbar({ selectionStart: 0, selectionEnd: 5, autocompleteOpen: false }),
    ).toBe(true);
  });

  it('빈 선택(start === end)이면 숨긴다', () => {
    expect(
      shouldShowFormatToolbar({ selectionStart: 3, selectionEnd: 3, autocompleteOpen: false }),
    ).toBe(false);
  });

  it('자동완성/멘션/슬래시 팝업이 열려 있으면 선택이 있어도 숨긴다(겹침 방지)', () => {
    expect(
      shouldShowFormatToolbar({ selectionStart: 0, selectionEnd: 5, autocompleteOpen: true }),
    ).toBe(false);
  });

  it('selection 정보가 없으면(null) 숨긴다', () => {
    expect(
      shouldShowFormatToolbar({
        selectionStart: null,
        selectionEnd: null,
        autocompleteOpen: false,
      }),
    ).toBe(false);
  });
});

describe('applyToolbarFormatToText (S83c / FR-KS-10)', () => {
  it('bold/italic/strike/code 는 마커로 감싼다(인라인)', () => {
    expect(applyToolbarFormatToText({ text: 'x', start: 0, end: 1, format: 'bold' }).text).toBe(
      '**x**',
    );
    expect(applyToolbarFormatToText({ text: 'x', start: 0, end: 1, format: 'italic' }).text).toBe(
      '_x_',
    );
    expect(applyToolbarFormatToText({ text: 'x', start: 0, end: 1, format: 'strike' }).text).toBe(
      '~~x~~',
    );
    expect(applyToolbarFormatToText({ text: 'x', start: 0, end: 1, format: 'code' }).text).toBe(
      '`x`',
    );
  });

  it('인라인 마커는 멀티라인이면 줄 단위로 감싼다(per-line)', () => {
    expect(applyToolbarFormatToText({ text: 'a\nb', start: 0, end: 3, format: 'bold' }).text).toBe(
      '**a**\n**b**',
    );
  });

  it('codeBlock 은 줄 시작이 아니면 여는 펜스 앞에 \\n 을 선행한다', () => {
    // 'foo bar' 의 'bar'(4~7) → 여는 펜스가 줄 중간이 아니라 개행 뒤에 오게.
    const r = applyToolbarFormatToText({ text: 'foo bar', start: 4, end: 7, format: 'codeBlock' });
    expect(r.text).toBe('foo \n```\nbar\n```');
  });

  it('codeBlock 이 줄 시작이면 \\n 을 선행하지 않는다', () => {
    const r = applyToolbarFormatToText({ text: 'bar', start: 0, end: 3, format: 'codeBlock' });
    expect(r.text).toBe('```\nbar\n```');
  });

  it('quote 는 `> ` 줄 prefix(per-line)로 적용한다', () => {
    expect(applyToolbarFormatToText({ text: 'a\nb', start: 0, end: 3, format: 'quote' }).text).toBe(
      '> a\n> b',
    );
  });

  it('link 는 `[선택](url)` 로 감싸고 url 플레이스홀더를 선택한다', () => {
    const r = applyToolbarFormatToText({ text: 'qufox', start: 0, end: 5, format: 'link' });
    expect(r.text).toBe('[qufox](url)');
    expect(r.text.slice(r.newStart, r.newEnd)).toBe(LINK_URL_PLACEHOLDER);
  });
});
