// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

const logoutMock = vi.fn();
vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ logout: logoutMock }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

// Dialog 는 alertDialog prop 을 노출하는 pass-through stub(파괴적 확인 검증용).
vi.mock('../../design-system/primitives', () => ({
  Dialog: ({
    children,
    open,
    alertDialog,
    title,
  }: {
    children?: ReactNode;
    open?: boolean;
    alertDialog?: boolean;
    title?: string;
  }) =>
    open ? (
      <div role={alertDialog ? 'alertdialog' : 'dialog'} aria-label={title}>
        {children}
      </div>
    ) : null,
}));

let totpEnabled: boolean;
const deactivate = vi.fn();
vi.mock('./useSecurity', () => ({
  useTwoFactorStatus: () => ({ data: { totpEnabled } }),
  useDeactivateAccount: () => ({ mutateAsync: deactivate, isPending: false }),
}));

import { AdvancedSettingsPage } from './AdvancedSettingsPage';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  totpEnabled = false;
  pushMock.mockReset();
  logoutMock.mockReset();
  logoutMock.mockResolvedValue(undefined);
  navigateMock.mockReset();
  deactivate.mockReset();
  deactivate.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('AdvancedSettingsPage (FR-PS-16·19)', () => {
  it('위험구역 + 비활성화 CTA 를 렌더한다', () => {
    render(<AdvancedSettingsPage />);
    expect(screen.getByTestId('advanced-danger-zone')).toBeTruthy();
    expect(screen.getByTestId('account-deactivate-open')).toBeTruthy();
  });

  it('CTA 클릭 → alertDialog 확인(현재 비번 입력) 노출', () => {
    render(<AdvancedSettingsPage />);
    fireEvent.click(screen.getByTestId('account-deactivate-open'));
    // 파괴적 확인은 role=alertdialog 로 노출되어야 한다(a11y).
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByTestId('deactivate-password')).toBeTruthy();
  });

  it('비번 입력 후 비활성화 → mutation 호출 + 자동 로그아웃 + /login 이동', async () => {
    render(<AdvancedSettingsPage />);
    fireEvent.click(screen.getByTestId('account-deactivate-open'));
    fireEvent.change(screen.getByTestId('deactivate-password'), {
      target: { value: 'my-current-pass-1' },
    });
    fireEvent.click(screen.getByTestId('deactivate-confirm'));

    await waitFor(() =>
      expect(deactivate).toHaveBeenCalledWith({ currentPassword: 'my-current-pass-1' }),
    );
    await waitFor(() => expect(logoutMock).toHaveBeenCalled());
    expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('잘못된 비번(PASSWORD_INCORRECT) → 인라인 에러, 로그아웃/이동 없음', async () => {
    deactivate.mockRejectedValueOnce(
      Object.assign(new Error('current password is incorrect'), {
        errorCode: 'PASSWORD_INCORRECT',
      }),
    );
    render(<AdvancedSettingsPage />);
    fireEvent.click(screen.getByTestId('account-deactivate-open'));
    fireEvent.change(screen.getByTestId('deactivate-password'), { target: { value: 'wrong-1' } });
    fireEvent.click(screen.getByTestId('deactivate-confirm'));

    await waitFor(() => expect(screen.getByTestId('deactivate-error')).toBeTruthy());
    expect(logoutMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('2FA 활성 시 인증 코드 입력 필드를 추가로 노출하고 totpCode 를 동봉', async () => {
    totpEnabled = true;
    render(<AdvancedSettingsPage />);
    fireEvent.click(screen.getByTestId('account-deactivate-open'));
    fireEvent.change(screen.getByTestId('deactivate-password'), { target: { value: 'pass-1' } });
    fireEvent.change(screen.getByTestId('deactivate-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('deactivate-confirm'));

    await waitFor(() =>
      expect(deactivate).toHaveBeenCalledWith({ currentPassword: 'pass-1', totpCode: '123456' }),
    );
  });
});
