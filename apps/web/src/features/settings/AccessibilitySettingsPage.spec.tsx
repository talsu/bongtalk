// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AccessibilitySettings } from '@qufox/shared-types';

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

let current: AccessibilitySettings;
let loading: boolean;
const mutateAsync = vi.fn();
vi.mock('./useAccessibilitySettings', () => ({
  useAccessibilitySettings: () => ({ data: current, isLoading: loading }),
  useUpdateAccessibilitySettings: () => ({ mutateAsync, isPending: false }),
}));

import { AccessibilitySettingsPage } from './AccessibilitySettingsPage';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  current = { reduceMotion: false, highContrast: false };
  loading = false;
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

  // F6 (a11y M-3): 로딩 중에는 aria-busy 영역을 보이고 토글은 아직 렌더하지 않는다.
  it('shows an aria-busy loading region while settings load', () => {
    loading = true;
    render(<AccessibilitySettingsPage />);
    const busy = screen.getByTestId('a11y-loading');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('a11y-reduce-motion-toggle')).toBeNull();
  });

  // F5 (a11y M-2): 토글은 aria-label + aria-describedby 로 접근명/설명을 연결하고, sr-only
  // h2 중복을 두지 않는다(이중 발화 제거).
  it('wires the toggle to a description via aria-describedby and has no duplicate sr-only h2', () => {
    render(<AccessibilitySettingsPage />);
    const toggle = screen.getByTestId('a11y-reduce-motion-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('모션 줄이기');
    expect(toggle.getAttribute('aria-describedby')).toBe('a11y-motion-desc');
    // sr-only 제목이 더 이상 존재하지 않는다(이전 #a11y-motion-heading 제거).
    expect(document.getElementById('a11y-motion-heading')).toBeNull();
  });
});
