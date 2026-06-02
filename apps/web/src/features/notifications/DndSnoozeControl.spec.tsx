// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DndSnoozeControl } from './DndSnoozeControl';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(cleanup);

describe('DndSnoozeControl (S48 FR-MN-11)', () => {
  it('dndUntil null → idle 상태 표시', () => {
    render(<DndSnoozeControl dndUntil={null} onSnooze={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByTestId('dnd-snooze-idle')).toBeTruthy();
    expect(screen.queryByTestId('dnd-snooze-active')).toBeNull();
  });

  it('dndUntil 미래 → active 상태 + 해제 버튼', () => {
    render(
      <DndSnoozeControl dndUntil="2025-01-01T01:00:00.000Z" onSnooze={vi.fn()} onClear={vi.fn()} />,
    );
    expect(screen.getByTestId('dnd-snooze-active')).toBeTruthy();
  });

  it('dndUntil 과거(만료) → idle 로 취급', () => {
    render(
      <DndSnoozeControl dndUntil="2024-12-31T23:00:00.000Z" onSnooze={vi.fn()} onClear={vi.fn()} />,
    );
    expect(screen.getByTestId('dnd-snooze-idle')).toBeTruthy();
  });

  it('프리셋 30분 클릭 → onSnooze(ISO) 호출(now+30분)', () => {
    const onSnooze = vi.fn();
    render(<DndSnoozeControl dndUntil={null} onSnooze={onSnooze} onClear={vi.fn()} />);
    fireEvent.click(screen.getByTestId('dnd-snooze-preset-thirty_min'));
    expect(onSnooze).toHaveBeenCalledTimes(1);
    const iso = onSnooze.mock.calls[0][0] as string;
    expect(iso).toBe('2025-01-01T00:30:00.000Z');
  });

  it('해제 버튼 → onClear 호출', () => {
    const onClear = vi.fn();
    render(
      <DndSnoozeControl dndUntil="2025-01-01T01:00:00.000Z" onSnooze={vi.fn()} onClear={onClear} />,
    );
    fireEvent.click(screen.getByTestId('dnd-snooze-clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('직접 설정 → datetime-local 입력 후 적용 → onSnooze(ISO)', () => {
    const onSnooze = vi.fn();
    render(<DndSnoozeControl dndUntil={null} onSnooze={onSnooze} onClear={vi.fn()} />);
    fireEvent.click(screen.getByTestId('dnd-snooze-custom-toggle'));
    const input = screen.getByTestId('dnd-snooze-custom-input');
    fireEvent.change(input, { target: { value: '2025-01-02T08:30' } });
    fireEvent.click(screen.getByTestId('dnd-snooze-custom-apply'));
    expect(onSnooze).toHaveBeenCalledTimes(1);
    // datetime-local 은 로컬 tz 로 해석된다 — tz 비의존으로 입력값 ISO 환산과 동일한지만 확인.
    const iso = onSnooze.mock.calls[0][0] as string;
    expect(iso).toBe(new Date('2025-01-02T08:30').toISOString());
  });
});
