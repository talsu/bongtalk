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
  current = {
    theme: 'DARK',
    density: 'COZY',
    chatFontSize: 15,
    clock24h: false,
    linkPreviewsEnabled: true,
  };
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

  // S84c (FR-RC19): 링크 미리보기 토글. 현재 true → 클릭 시 false 로 PATCH.
  it('toggles linkPreviewsEnabled immediately', () => {
    render(<AppearanceSettingsPage />);
    const toggle = screen.getByTestId('appearance-linkpreview-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(mutateAsync).toHaveBeenCalledWith({ linkPreviewsEnabled: false });
  });

  // 072-N6-5 (D2 승인): 폰트 슬라이더 활성화 — 변경 시 6단계 중 선택값을 PATCH 한다.
  it('enables the chat font slider and PATCHes the selected step (D2)', () => {
    render(<AppearanceSettingsPage />);
    const slider = screen.getByTestId('appearance-font-slider') as HTMLInputElement;
    expect(slider.disabled).toBe(false);
    // index 5 = CHAT_FONT_SIZES[5] = 18px.
    fireEvent.change(slider, { target: { value: '5' } });
    expect(mutateAsync).toHaveBeenCalledWith({ chatFontSize: 18 });
    // 현재 저장된 px 안내가 노출된다.
    expect(screen.getByTestId('appearance-font-hint').textContent).toContain('15px');
  });

  // F-H4 (a11y HIGH-04): 저장 성공 시 라이브 영역에 "저장됨" 이 통지된다.
  it('announces "저장됨" in a live region after a successful save (F-H4)', async () => {
    render(<AppearanceSettingsPage />);
    expect(screen.getByTestId('appearance-save-status').textContent).toBe('');
    fireEvent.click(screen.getByTestId('appearance-theme-LIGHT'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('appearance-save-status').textContent).toBe('저장됨');
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
