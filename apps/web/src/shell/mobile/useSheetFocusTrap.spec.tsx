// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { useSheetFocusTrap, type SheetFocusTrapOptions } from './useSheetFocusTrap';

/**
 * 071-M5 H3 — useSheetFocusTrap 훅 spec.
 *
 * ThreadPanel.a11y.spec.tsx 의 Tab 순환/Esc/복귀 검증 패턴을 훅 단위로 이식한다.
 * 이 spec 하나가 훅 적용 시트 전 표면(MessageSheet/ChannelSheet/ServerMenu/
 * EditSheet/EditHistory/EmojiDrawer/YouTab 2종/DM new/친구추가)의 트랩 회귀를
 * 단일 지점에서 커버한다(각 시트 spec 에 트랩 중복 검증 불필요).
 */

function Sheet({
  onClose,
  opts,
  buttons = ['첫째', '둘째', '셋째'],
}: {
  onClose: () => void;
  opts?: SheetFocusTrapOptions;
  buttons?: string[];
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useSheetFocusTrap(panelRef, onClose, opts);
  return (
    <div ref={panelRef} data-testid="trap-panel" role="dialog" aria-modal="true">
      {buttons.map((b) => (
        <button key={b} type="button" data-testid={`trap-btn-${b}`}>
          {b}
        </button>
      ))}
    </div>
  );
}

/** focusable 0개 폴백 경로(닫기 버튼 없는 시트 — EditHistorySheet 류). */
function EmptySheet({ onClose }: { onClose: () => void }): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useSheetFocusTrap(panelRef, onClose);
  return <div ref={panelRef} data-testid="trap-empty-panel" />;
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => {
  cleanup();
});

describe('useSheetFocusTrap (071-M5 H3)', () => {
  it('마운트 시 첫 포커서블로 포커스를 옮긴다', () => {
    render(<Sheet onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByTestId('trap-btn-첫째'));
  });

  it('initialFocus 지정 시 그 요소로 포커스한다(취소 첫 포커스 — A-30)', () => {
    render(
      <Sheet
        onClose={vi.fn()}
        opts={{
          initialFocus: () => screen.getByTestId('trap-btn-셋째'),
        }}
      />,
    );
    expect(document.activeElement).toBe(screen.getByTestId('trap-btn-셋째'));
  });

  it('마지막 포커서블에서 Tab → 첫 요소로 순환한다', () => {
    render(<Sheet onClose={vi.fn()} />);
    screen.getByTestId('trap-btn-셋째').focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('trap-btn-첫째'));
  });

  it('첫 포커서블에서 Shift+Tab → 마지막 요소로 순환한다', () => {
    render(<Sheet onClose={vi.fn()} />);
    screen.getByTestId('trap-btn-첫째').focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('trap-btn-셋째'));
  });

  it('Escape → onClose 호출(최신 콜백 — onCloseRef 경유)', () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('언마운트 시 열기 직전 활성 요소로 포커스를 복귀한다', () => {
    // 시트 밖 트리거를 먼저 포커스해 두고 시트를 열었다 닫는다.
    const trigger = document.createElement('button');
    trigger.setAttribute('data-testid', 'outside-trigger');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(<Sheet onClose={vi.fn()} />);
    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('focusable 0개면 패널 자체를 포커스(tabIndex=-1 폴백)하고 Tab 누설을 막는다', () => {
    render(<EmptySheet onClose={vi.fn()} />);
    const panel = screen.getByTestId('trap-empty-panel');
    expect(document.activeElement).toBe(panel);
    expect(panel.tabIndex).toBe(-1);
    fireEvent.keyDown(window, { key: 'Tab' });
    // 포커서블이 없어도 포커스가 배경으로 새지 않는다.
    expect(document.activeElement).toBe(panel);
  });
});
