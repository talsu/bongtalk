// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { FormatToolbar, type FormatToolbarHandle } from './FormatToolbar';
import {
  applyToolbarFormatToText,
  shouldShowFormatToolbar,
  type ToolbarFormat,
} from './formatWrap';

/**
 * S83c round-2(reviewer MED-2): FormatToolbar ↔ MessageComposer 통합 spec(jsdom).
 *
 * 전체 MessageComposer 는 수십 개 훅(useSendMessage/useAutocomplete/소켓/스토어…)에 의존하므로,
 * 라운드-2 가 바꾼 toolbar↔composer 배선만 충실히 재현한 하니스(Harness)로 통합 경로를 검증한다:
 *   - showFormatToolbar 게이트 = shouldShowFormatToolbar(드리프트 방지, MED-1)
 *   - textarea onSelect → 비어있지 않은 선택이면 툴바 노출
 *   - 툴바 버튼 클릭 → applyToolbarFormatToText 로 draft 변형(클릭 경로)
 *   - 비-툴바 대상으로 blur → toolbarRef.current.contains(relatedTarget) 로 닫힘(testid 쿼리 제거)
 *   - 툴바 버튼으로 blur → 닫히지 않음
 *   - Tab(Shift 없음) → 툴바 첫 버튼 focus(키보드 진입, BLOCKER 2.1.1)
 *   - 툴바 Esc → textarea 복귀
 * 포털 마운트라 testid 는 document.body 전역(within(document.body))에서 잡는다.
 */

function Harness(): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toolbarRef = useRef<FormatToolbarHandle>(null);
  const [draft, setDraft] = useState('hello world');
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | null>(null);

  const syncSelection = (el: HTMLTextAreaElement): void => {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    setSelectionRange(start !== end ? { start, end } : null);
  };

  // composer 와 동일하게 테스트된 순수 함수를 게이트로 쓴다(드리프트 방지).
  const showFormatToolbar = shouldShowFormatToolbar({
    selectionStart: selectionRange?.start ?? null,
    selectionEnd: selectionRange?.end ?? null,
    autocompleteOpen: false,
  });

  const applyToolbarFormat = (format: ToolbarFormat): void => {
    // 하니스는 선택 범위를 state(selectionRange)에서 읽는다 — jsdom 의 button.click() 은
    // 실제 mousedown 시퀀스를 안 쏘아 textarea 의 live selection 이 보존되지 않기 때문이다
    // (실앱은 onMouseDown preventDefault 로 selection 이 유지된 채 el.selectionStart 를 읽음).
    if (!selectionRange) return;
    const r = applyToolbarFormatToText({
      text: draft,
      start: selectionRange.start,
      end: selectionRange.end,
      format,
    });
    setDraft(r.text);
  };

  return (
    <div>
      <textarea
        data-testid="ta"
        aria-label="메시지 입력"
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onSelect={(e) => syncSelection(e.currentTarget)}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (toolbarRef.current?.contains(next)) return;
          setSelectionRange(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Tab' && !e.shiftKey && showFormatToolbar) {
            e.preventDefault();
            toolbarRef.current?.focusFirst();
          }
        }}
      />
      {showFormatToolbar ? (
        <FormatToolbar
          ref={toolbarRef}
          anchorRef={textareaRef}
          onApply={applyToolbarFormat}
          onClose={() => setSelectionRange(null)}
        />
      ) : null}
    </div>
  );
}

/** textarea 에 선택 범위를 설정하고 onSelect 를 발화한다(jsdom 은 select 이벤트를 안 쏨). */
function selectRange(ta: HTMLTextAreaElement, start: number, end: number): void {
  ta.focus();
  ta.setSelectionRange(start, end);
  fireEvent.select(ta);
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('FormatToolbar ↔ composer 통합 (S83c round-2 / MED-2)', () => {
  it('텍스트를 선택하면 툴바가 등장한다(빈 선택이면 숨김)', () => {
    const { getByTestId } = render(<Harness />);
    const doc = within(document.body);
    const ta = getByTestId('ta') as HTMLTextAreaElement;
    // 빈 선택 — 툴바 없음.
    expect(doc.queryByTestId('format-toolbar')).toBeNull();
    // 'world' 선택(6..11) — 툴바 등장.
    selectRange(ta, 6, 11);
    expect(doc.getByTestId('format-toolbar')).toBeTruthy();
  });

  it('버튼 클릭 → draft 가 해당 서식으로 변형된다', () => {
    const { getByTestId } = render(<Harness />);
    const doc = within(document.body);
    const ta = getByTestId('ta') as HTMLTextAreaElement;
    selectRange(ta, 6, 11);
    // bold 클릭 — 'world' 가 **world** 로(fireEvent.click 으로 React 합성 onClick 발화).
    fireEvent.click(doc.getByTestId('format-toolbar-bold'));
    expect((getByTestId('ta') as HTMLTextAreaElement).value).toBe('hello **world**');
  });

  it('quote 버튼 클릭 → 줄 prefix 서식이 적용된다(툴바 전용 액션)', () => {
    const { getByTestId } = render(<Harness />);
    const doc = within(document.body);
    const ta = getByTestId('ta') as HTMLTextAreaElement;
    selectRange(ta, 0, 11);
    fireEvent.click(doc.getByTestId('format-toolbar-quote'));
    expect((getByTestId('ta') as HTMLTextAreaElement).value).toBe('> hello world');
  });

  it('비-툴바 대상으로 blur 하면 툴바가 숨는다', () => {
    const { getByTestId } = render(<Harness />);
    const doc = within(document.body);
    const ta = getByTestId('ta') as HTMLTextAreaElement;
    selectRange(ta, 6, 11);
    expect(doc.getByTestId('format-toolbar')).toBeTruthy();
    // relatedTarget 이 툴바 밖(body) — 닫힘.
    fireEvent.blur(ta, { relatedTarget: document.body });
    expect(doc.queryByTestId('format-toolbar')).toBeNull();
  });

  it('툴바 버튼으로 blur 하면(relatedTarget 이 툴바 내부) 툴바가 유지된다', () => {
    const { getByTestId } = render(<Harness />);
    const doc = within(document.body);
    const ta = getByTestId('ta') as HTMLTextAreaElement;
    selectRange(ta, 6, 11);
    const boldBtn = doc.getByTestId('format-toolbar-bold');
    fireEvent.blur(ta, { relatedTarget: boldBtn });
    expect(doc.getByTestId('format-toolbar')).toBeTruthy();
  });

  it('Tab(Shift 없음) → 툴바 첫 버튼으로 포커스가 이동한다(키보드 진입)', () => {
    const { getByTestId } = render(<Harness />);
    const doc = within(document.body);
    const ta = getByTestId('ta') as HTMLTextAreaElement;
    selectRange(ta, 6, 11);
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(document.activeElement).toBe(doc.getByTestId('format-toolbar-bold'));
  });

  it('툴바에서 Esc → textarea 로 포커스 복귀 + 닫힘', () => {
    const { getByTestId } = render(<Harness />);
    const doc = within(document.body);
    const ta = getByTestId('ta') as HTMLTextAreaElement;
    selectRange(ta, 6, 11);
    const toolbar = doc.getByTestId('format-toolbar');
    fireEvent.keyDown(toolbar, { key: 'Escape' });
    expect(document.activeElement).toBe(ta);
    expect(doc.queryByTestId('format-toolbar')).toBeNull();
  });

  // S83c round-3(B-1b): Tab(Shift 무관) 으로 툴바를 벗어나면 닫히고 textarea 로 복귀한다
  // (트랜지언트 팝업 — 고아 잔류 방지). 진입(textarea Tab)→이탈(toolbar Tab) 왕복을 검증.
  it('툴바에서 Tab → textarea 로 포커스 복귀 + 닫힘(고아 잔류 방지)', () => {
    const { getByTestId } = render(<Harness />);
    const doc = within(document.body);
    const ta = getByTestId('ta') as HTMLTextAreaElement;
    selectRange(ta, 6, 11);
    fireEvent.keyDown(ta, { key: 'Tab' });
    const toolbar = doc.getByTestId('format-toolbar');
    expect(document.activeElement).toBe(doc.getByTestId('format-toolbar-bold'));
    fireEvent.keyDown(toolbar, { key: 'Tab' });
    expect(document.activeElement).toBe(ta);
    expect(doc.queryByTestId('format-toolbar')).toBeNull();
  });

  it('툴바에서 Shift+Tab → textarea 로 포커스 복귀 + 닫힘', () => {
    const { getByTestId } = render(<Harness />);
    const doc = within(document.body);
    const ta = getByTestId('ta') as HTMLTextAreaElement;
    selectRange(ta, 6, 11);
    fireEvent.keyDown(ta, { key: 'Tab' });
    const toolbar = doc.getByTestId('format-toolbar');
    fireEvent.keyDown(toolbar, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(ta);
    expect(doc.queryByTestId('format-toolbar')).toBeNull();
  });

  // S83c round-3(B-1b focusout 안전망): 포커스가 툴바 밖(클릭아웃 등)으로 새면 닫힌다.
  it('툴바 버튼에서 툴바 밖으로 포커스가 이탈하면 닫힌다(focusout 안전망)', () => {
    const { getByTestId } = render(<Harness />);
    const doc = within(document.body);
    const ta = getByTestId('ta') as HTMLTextAreaElement;
    selectRange(ta, 6, 11);
    fireEvent.keyDown(ta, { key: 'Tab' });
    const bold = doc.getByTestId('format-toolbar-bold');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    fireEvent.blur(bold, { relatedTarget: outside });
    expect(doc.queryByTestId('format-toolbar')).toBeNull();
  });

  it('roving: 툴바 진입 후 ←/→ 로 버튼을 순회하고 tabIndex 가 따라온다', () => {
    const { getByTestId } = render(<Harness />);
    const doc = within(document.body);
    const ta = getByTestId('ta') as HTMLTextAreaElement;
    selectRange(ta, 6, 11);
    fireEvent.keyDown(ta, { key: 'Tab' });
    const toolbar = doc.getByTestId('format-toolbar');
    expect(doc.getByTestId('format-toolbar-bold').getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(doc.getByTestId('format-toolbar-italic'));
    expect(doc.getByTestId('format-toolbar-italic').getAttribute('tabindex')).toBe('0');
    expect(doc.getByTestId('format-toolbar-bold').getAttribute('tabindex')).toBe('-1');
  });
});
