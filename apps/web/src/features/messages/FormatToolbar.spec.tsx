// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { FormatToolbar } from './FormatToolbar';
import type { ToolbarFormat } from './formatWrap';

/**
 * S83c (FR-KS-10): 인라인 포맷 툴바 단위 테스트. 표시/버튼/마커 위임/Esc 닫기+포커스 복귀/
 * onMouseDown preventDefault/a11y(role=toolbar·aria-label·방향키 이동)를 검증한다.
 */

function setup() {
  const onApply = vi.fn();
  const onClose = vi.fn();
  const anchorRef = createRef<HTMLTextAreaElement>();
  // anchor textarea 를 실제 DOM 에 마운트해 getBoundingClientRect/포커스가 동작하게 한다.
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  // createRef 는 readonly current 라 Object.assign 으로 주입(테스트 한정).
  Object.assign(anchorRef, { current: ta });
  const onApplyTyped = onApply as unknown as (_format: ToolbarFormat) => void;
  const utils = render(
    <FormatToolbar anchorRef={anchorRef} onApply={onApplyTyped} onClose={onClose} />,
  );
  return { ...utils, onApply, onClose, anchor: ta };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('FormatToolbar (S83c / FR-KS-10)', () => {
  it('renders a toolbar with role=toolbar and aria-label', () => {
    const { getByRole } = setup();
    const toolbar = getByRole('toolbar');
    expect(toolbar).toBeTruthy();
    expect(toolbar.getAttribute('aria-label')).toBe('텍스트 서식');
  });

  it('renders all seven format buttons with aria-labels', () => {
    const { getByTestId } = setup();
    const expected: Array<[ToolbarFormat, string]> = [
      ['bold', '굵게'],
      ['italic', '기울임'],
      ['strike', '취소선'],
      ['code', '인라인 코드'],
      ['codeBlock', '코드 블록'],
      ['quote', '인용'],
      ['link', '링크'],
    ];
    for (const [fmt, label] of expected) {
      const btn = getByTestId(`format-toolbar-${fmt}`);
      expect(btn.getAttribute('aria-label')).toBe(label);
    }
  });

  it('each button delegates its ToolbarFormat to onApply on click', () => {
    const { getByTestId, onApply } = setup();
    getByTestId('format-toolbar-bold').click();
    getByTestId('format-toolbar-quote').click();
    getByTestId('format-toolbar-link').click();
    expect(onApply).toHaveBeenNthCalledWith(1, 'bold');
    expect(onApply).toHaveBeenNthCalledWith(2, 'quote');
    expect(onApply).toHaveBeenNthCalledWith(3, 'link');
  });

  it('buttons call preventDefault on mousedown (keeps the textarea selection)', () => {
    const { getByTestId } = setup();
    const btn = getByTestId('format-toolbar-bold');
    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  it('Esc closes the toolbar and returns focus to the anchor textarea', () => {
    const { getByRole, onClose, anchor } = setup();
    const toolbar = getByRole('toolbar');
    fireEvent.keyDown(toolbar, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(anchor);
  });

  it('ArrowRight / ArrowLeft move focus between buttons (roving)', () => {
    const { getByTestId, getByRole } = setup();
    const first = getByTestId('format-toolbar-bold');
    const toolbar = getByRole('toolbar');
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(getByTestId('format-toolbar-italic'));
    fireEvent.keyDown(toolbar, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
    // wrap-around: from the first, ArrowLeft goes to the last (link).
    fireEvent.keyDown(toolbar, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(getByTestId('format-toolbar-link'));
  });

  it('uses DS qf-btn classes on each button (no raw styling)', () => {
    const { getByTestId } = setup();
    const btn = getByTestId('format-toolbar-bold');
    expect(btn.className).toContain('qf-btn');
    expect((btn as HTMLElement).style.background).toBe('');
  });
});
