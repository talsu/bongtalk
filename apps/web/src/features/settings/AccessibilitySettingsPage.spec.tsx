// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AccessibilitySettings } from '@qufox/shared-types';

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

let current: AccessibilitySettings;
const mutateAsync = vi.fn();
vi.mock('./useAccessibilitySettings', () => ({
  useAccessibilitySettings: () => ({ data: current }),
  useUpdateAccessibilitySettings: () => ({ mutateAsync, isPending: false }),
}));

import { AccessibilitySettingsPage } from './AccessibilitySettingsPage';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  current = { reduceMotion: false, highContrast: false };
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue(current);
  pushMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AccessibilitySettingsPage (FR-PS-12)', () => {
  it('PATCHes reduceMotion immediately on toggle', () => {
    render(<AccessibilitySettingsPage />);
    fireEvent.click(screen.getByTestId('a11y-reduce-motion-toggle'));
    expect(mutateAsync).toHaveBeenCalledWith({ reduceMotion: true });
  });

  it('PATCHes highContrast immediately on toggle', () => {
    render(<AccessibilitySettingsPage />);
    fireEvent.click(screen.getByTestId('a11y-high-contrast-toggle'));
    expect(mutateAsync).toHaveBeenCalledWith({ highContrast: true });
  });

  it('reflects the current reduceMotion state on the switch (aria-checked)', () => {
    current = { reduceMotion: true, highContrast: false };
    render(<AccessibilitySettingsPage />);
    expect(screen.getByTestId('a11y-reduce-motion-toggle').getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('announces "저장됨" in a live region after a successful save', async () => {
    render(<AccessibilitySettingsPage />);
    expect(screen.getByTestId('a11y-save-status').textContent).toBe('');
    fireEvent.click(screen.getByTestId('a11y-reduce-motion-toggle'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('a11y-save-status').textContent).toBe('저장됨');
  });

  it('shows a danger toast when a PATCH fails', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('boom'));
    render(<AccessibilitySettingsPage />);
    fireEvent.click(screen.getByTestId('a11y-reduce-motion-toggle'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger', title: '모션 설정 저장 실패' }),
    );
  });
});
