// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import type { AppearanceSettings } from '@qufox/shared-types';

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

let current: AppearanceSettings;
const mutateAsync = vi.fn();
vi.mock('./useAppearanceSettings', () => ({
  useAppearanceSettings: () => ({ data: current }),
  useUpdateAppearanceSettings: () => ({ mutateAsync, isPending: false }),
}));

import { AppearanceSettingsPage } from './AppearanceSettingsPage';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  current = { theme: 'DARK', density: 'COZY', chatFontSize: 15, clock24h: false };
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue(current);
  pushMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AppearanceSettingsPage (FR-PS-09 · Fork B1)', () => {
  it('PATCHes theme immediately on radio change', () => {
    render(<AppearanceSettingsPage />);
    fireEvent.click(screen.getByTestId('appearance-theme-LIGHT'));
    expect(mutateAsync).toHaveBeenCalledWith({ theme: 'LIGHT' });
  });

  it('PATCHes density immediately on radio change', () => {
    render(<AppearanceSettingsPage />);
    fireEvent.click(screen.getByTestId('appearance-density-COMPACT'));
    expect(mutateAsync).toHaveBeenCalledWith({ density: 'COMPACT' });
  });

  it('toggles clock24h immediately', () => {
    render(<AppearanceSettingsPage />);
    fireEvent.click(screen.getByTestId('appearance-clock-toggle'));
    expect(mutateAsync).toHaveBeenCalledWith({ clock24h: true });
  });

  it('debounces the font slider — single PATCH after 200ms', () => {
    render(<AppearanceSettingsPage />);
    const slider = screen.getByTestId('appearance-font-slider');
    // index 0..5 → [12,13,14,15,16,18]. Drag through 3 then 4 then 5.
    fireEvent.change(slider, { target: { value: '3' } });
    fireEvent.change(slider, { target: { value: '4' } });
    fireEvent.change(slider, { target: { value: '5' } });
    // Before debounce fires, no PATCH yet.
    expect(mutateAsync).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Only the final value (index 5 = 18px) is sent, exactly once.
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ chatFontSize: 18 });
  });

  it('shows a danger toast when a PATCH fails (revert is handled by the hook)', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('boom'));
    render(<AppearanceSettingsPage />);
    fireEvent.click(screen.getByTestId('appearance-theme-LIGHT'));
    // flush the rejected promise microtask.
    await act(async () => {
      await Promise.resolve();
    });
    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger', title: '테마 저장 실패' }),
    );
  });
});
