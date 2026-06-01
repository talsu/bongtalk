// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { classifyReadShortcut } from './readShortcut';

/**
 * S23 BLOCKER fix: Esc 가 EmojiPicker/ThreadPanel/SearchInput 같은 오버레이를
 * 닫는 데 소비될 때, 같은 Esc 로 useGlobalShortcuts 의 read 단축키(mark-current)가
 * 동시에 발화해 채널이 강제 읽음 처리되는 회귀를 막는다.
 *
 * 방어는 이중이다:
 *   (a) 오버레이의 window keydown 리스너가 Esc 처리 시 preventDefault() +
 *       stopPropagation() 을 호출한다(EmojiPicker:onKey / ThreadPanel:onKey /
 *       SearchInput:onKeyDown).
 *   (b) useGlobalShortcuts 의 핸들러는 `e.defaultPrevented` 면 read 단축키를
 *       skip 한다.
 *
 * 본 스펙은 두 window keydown 리스너(먼저 오버레이, 다음 전역)를 실제 jsdom
 * 이벤트로 구동해, 오버레이가 preventDefault 했을 때 전역 핸들러의 read 분기가
 * 발화하지 않음을 검증한다. 전역 핸들러는 useGlobalShortcuts 와 동일한 가드
 * 순서(defaultPrevented → classify)를 재현한다(React 렌더 없이 핵심 seam 검증).
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** EmojiPicker/ThreadPanel 의 Esc 소비 리스너와 동일 형태. */
function overlayEscListener(onDismiss: () => void) {
  return (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    }
  };
}

/** useGlobalShortcuts 의 read 분기와 동일한 가드 순서를 재현. */
function globalReadListener(onMarkCurrent: () => void) {
  return (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return; // (b) 이중 방어
    const action = classifyReadShortcut(e, { inputActive: false, modalOpen: false });
    if (action === 'mark-current') {
      e.preventDefault();
      onMarkCurrent();
    }
  };
}

describe('Esc 오버레이 충돌 가드 (S23 BLOCKER)', () => {
  it('오버레이가 열려 Esc 를 소비하면 mark-current 미발화', () => {
    const dismiss = vi.fn();
    const markCurrent = vi.fn();
    const overlay = overlayEscListener(dismiss);
    const global = globalReadListener(markCurrent);
    // 오버레이가 먼저 등록(컴포넌트 마운트 순서 — 전역은 Shell 마운트 시 1회).
    window.addEventListener('keydown', overlay);
    window.addEventListener('keydown', global);
    try {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(markCurrent).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', overlay);
      window.removeEventListener('keydown', global);
    }
  });

  it('오버레이가 없으면 Esc 가 정상적으로 mark-current 를 발화', () => {
    const markCurrent = vi.fn();
    const global = globalReadListener(markCurrent);
    window.addEventListener('keydown', global);
    try {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      expect(markCurrent).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', global);
    }
  });
});
