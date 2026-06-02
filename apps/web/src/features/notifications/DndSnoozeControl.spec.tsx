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

describe('DndSnoozeControl a11y (S48 fix-forward)', () => {
  // A-01: 프리셋 radiogroup + role=radio + aria-checked.
  it('프리셋 래퍼 role=radiogroup + aria-label, 각 버튼 role=radio', () => {
    render(<DndSnoozeControl dndUntil={null} onSnooze={vi.fn()} onClear={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: '방해 금지 기간' });
    expect(group).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(4);
    // idle 상태이므로 어떤 radio 도 checked 아님.
    radios.forEach((r) => expect(r.getAttribute('aria-checked')).toBe('false'));
  });

  it('A-01: active snooze 가 특정 프리셋과 일치하면 그 radio 가 aria-checked', () => {
    // now=2025-01-01T00:00Z, thirty_min = +30분 = 00:30Z.
    render(
      <DndSnoozeControl dndUntil="2025-01-01T00:30:00.000Z" onSnooze={vi.fn()} onClear={vi.fn()} />,
    );
    const thirty = screen.getByTestId('dnd-snooze-preset-thirty_min');
    expect(thirty.getAttribute('aria-checked')).toBe('true');
    const hour = screen.getByTestId('dnd-snooze-preset-one_hour');
    expect(hour.getAttribute('aria-checked')).toBe('false');
  });

  // A-02: 항상 DOM 에 존재하는 aria-live 컨테이너.
  it('A-02: idle 에서도 aria-live=polite 고정 컨테이너 존재', () => {
    const { container } = render(
      <DndSnoozeControl dndUntil={null} onSnooze={vi.fn()} onClear={vi.fn()} />,
    );
    const live = container.querySelector('[aria-live="polite"][aria-atomic="true"]');
    expect(live).toBeTruthy();
  });

  // A-03: 해제 버튼 aria-label.
  it('A-03: 해제 버튼 aria-label="방해 금지 해제"', () => {
    render(
      <DndSnoozeControl dndUntil="2025-01-01T01:00:00.000Z" onSnooze={vi.fn()} onClear={vi.fn()} />,
    );
    expect(screen.getByLabelText('방해 금지 해제')).toBeTruthy();
  });

  // A-04: 직접설정 버튼 aria-expanded + aria-controls.
  it('A-04: 직접설정 버튼 aria-expanded 토글 + aria-controls 패널 연결', () => {
    render(<DndSnoozeControl dndUntil={null} onSnooze={vi.fn()} onClear={vi.fn()} />);
    const toggle = screen.getByTestId('dnd-snooze-custom-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const panelId = toggle.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByTestId('dnd-snooze-custom');
    expect(panel.getAttribute('id')).toBe(panelId);
  });

  // A-05: custom 검증 — 60초 미만/Invalid → 한국어 에러 + aria-invalid + role=alert.
  it('A-05: 과거(60초 미만) 입력 → 한국어 에러 role=alert, onSnooze 미호출, aria-invalid', () => {
    const onSnooze = vi.fn();
    render(<DndSnoozeControl dndUntil={null} onSnooze={onSnooze} onClear={vi.fn()} />);
    fireEvent.click(screen.getByTestId('dnd-snooze-custom-toggle'));
    const input = screen.getByTestId('dnd-snooze-custom-input');
    // now=2025-01-01T00:00Z. 과거 시각.
    fireEvent.change(input, { target: { value: '2024-12-31T00:00' } });
    fireEvent.click(screen.getByTestId('dnd-snooze-custom-apply'));
    expect(onSnooze).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('지금으로부터 최소 1분 이후 시각을 선택해 주세요.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.getAttribute('id'));
  });

  it('A-05: 7일 초과 입력 → 한국어 에러, onSnooze 미호출', () => {
    const onSnooze = vi.fn();
    render(<DndSnoozeControl dndUntil={null} onSnooze={onSnooze} onClear={vi.fn()} />);
    fireEvent.click(screen.getByTestId('dnd-snooze-custom-toggle'));
    const input = screen.getByTestId('dnd-snooze-custom-input');
    // now+8일(로컬 tz 무관하게 8일 후라 7일 초과).
    fireEvent.change(input, { target: { value: '2025-01-09T00:00' } });
    fireEvent.click(screen.getByTestId('dnd-snooze-custom-apply'));
    expect(onSnooze).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('최대 7일 이내의 시각을 선택해 주세요.');
  });

  it('A-05: datetime-local 에 min/max attr 부여(now+60s ~ now+7일)', () => {
    render(<DndSnoozeControl dndUntil={null} onSnooze={vi.fn()} onClear={vi.fn()} />);
    fireEvent.click(screen.getByTestId('dnd-snooze-custom-toggle'));
    const input = screen.getByTestId('dnd-snooze-custom-input') as HTMLInputElement;
    expect(input.getAttribute('min')).toBeTruthy();
    expect(input.getAttribute('max')).toBeTruthy();
  });
});
