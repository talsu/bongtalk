// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

// S53 (D10 / FR-PS-09): ReminderModal — 프리셋 선택 → onSubmit(UTC ISO) 호출,
// "리마인더 해제" → onSubmit(null) 검증. Dialog/Input/Button 은 pass-through 모킹
// (portal/Radix 거동 회피, 모달 로직에 집중).
vi.mock('../../design-system/primitives', () => {
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? <div role="dialog">{children}</div> : null,
    Button: ({
      children,
      onClick,
      disabled,
      ...rest
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      [k: string]: unknown;
    }) => (
      <button type="button" onClick={onClick} disabled={disabled} {...rest}>
        {children}
      </button>
    ),
    // 실제 ReminderModal 의 Input 은 aria-label 을 prop 으로 받으므로 그대로 전개한다
    // (a11y 라벨은 호출부가 책임 — 모킹 input 도 label 누락으로 플래그되지 않게 한다).
    Input: ({ onChange, value, ...rest }: Record<string, unknown>) => (
      <input
        aria-label="reminder-mock-input"
        value={value as string}
        onChange={onChange as (e: unknown) => void}
        {...(rest as Record<string, unknown>)}
      />
    ),
  };
});

import { ReminderModal } from './ReminderModal';

describe('ReminderModal', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
  });
  afterEach(() => cleanup());

  it('기본 프리셋(30분 후) 선택 후 설정 시 UTC ISO 를 onSubmit 으로 넘긴다', () => {
    const onSubmit = vi.fn();
    render(
      <ReminderModal
        open
        channelName="general"
        hasReminder={false}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByTestId('reminder-submit'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0][0] as string;
    // 30분 후 = 2025-01-01T12:30:00Z.
    expect(arg).toBe('2025-01-01T12:30:00.000Z');
  });

  it('1시간 후 프리셋 선택 시 now+1h', () => {
    const onSubmit = vi.fn();
    render(
      <ReminderModal
        open
        channelName="general"
        hasReminder={false}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByTestId('reminder-preset-in1h'));
    fireEvent.click(screen.getByTestId('reminder-submit'));
    expect(onSubmit.mock.calls[0][0]).toBe('2025-01-01T13:00:00.000Z');
  });

  it('hasReminder 면 "리마인더 해제" 버튼이 onSubmit(null) 호출', () => {
    const onSubmit = vi.fn();
    render(
      <ReminderModal
        open
        channelName="general"
        hasReminder
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByTestId('reminder-clear'));
    expect(onSubmit).toHaveBeenCalledWith(null);
  });

  it('hasReminder 가 false 면 해제 버튼 없음', () => {
    render(
      <ReminderModal
        open
        channelName="general"
        hasReminder={false}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(screen.queryByTestId('reminder-clear')).toBeNull();
  });

  it('직접 입력 선택 시 값이 없으면 설정 버튼 비활성', () => {
    render(
      <ReminderModal
        open
        channelName="general"
        hasReminder={false}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('reminder-preset-custom'));
    expect((screen.getByTestId('reminder-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});
