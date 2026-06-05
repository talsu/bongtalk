// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ status: 'authenticated', user: { id: 'u1', email: 'me@qufox.dev', username: 'me', emailVerified: true } }),
}));

// Dialog 는 portal/Radix 거동을 피해 pass-through 로 모킹(열림 상태만 노출).
vi.mock('../../design-system/primitives', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
}));

let totpEnabled: boolean;
let totpLoading: boolean;
const refetch = vi.fn();
const changePassword = vi.fn();
const changeEmail = vi.fn();
vi.mock('./useSecurity', () => ({
  useTwoFactorStatus: () => ({ data: { totpEnabled }, isLoading: totpLoading, refetch }),
  useChangePassword: () => ({ mutateAsync: changePassword, isPending: false }),
  useChangeEmail: () => ({ mutateAsync: changeEmail, isPending: false }),
}));

// 하위 컴포넌트는 가벼운 stub 으로(렌더 + open prop 전달 검증).
vi.mock('./TotpSetupWizard', () => ({
  TotpSetupWizard: ({ open }: { open: boolean }) =>
    open ? <div data-testid="totp-setup-wizard-open" /> : null,
}));
vi.mock('./TotpDisableModal', () => ({
  TotpDisableModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="totp-disable-modal-open" /> : null,
}));
vi.mock('./SessionsSection', () => ({
  SessionsSection: () => <div data-testid="sessions-section-stub" />,
}));

import { AccountSettingsPage } from './AccountSettingsPage';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  totpEnabled = false;
  totpLoading = false;
  pushMock.mockReset();
  refetch.mockReset();
  changePassword.mockReset();
  changePassword.mockResolvedValue(undefined);
  changeEmail.mockReset();
  changeEmail.mockResolvedValue({ pendingEmail: 'new@qufox.dev' });
});
afterEach(() => cleanup());

describe('AccountSettingsPage (FR-PS-15·20)', () => {
  it('현재 이메일을 표시하고 세션 섹션을 렌더한다', () => {
    render(<AccountSettingsPage />);
    expect(screen.getByTestId('account-email').textContent).toBe('me@qufox.dev');
    expect(screen.getByTestId('sessions-section-stub')).toBeTruthy();
  });

  it('2FA 비활성 시 "설정" 버튼 → 설정 마법사를 연다', () => {
    render(<AccountSettingsPage />);
    expect(screen.getByTestId('totp-status').textContent).toBe('비활성화됨');
    fireEvent.click(screen.getByTestId('totp-setup-open'));
    expect(screen.getByTestId('totp-setup-wizard-open')).toBeTruthy();
  });

  it('2FA 활성 시 "해제" 버튼 → 해제 모달을 연다', () => {
    totpEnabled = true;
    render(<AccountSettingsPage />);
    expect(screen.getByTestId('totp-status').textContent).toBe('활성화됨');
    fireEvent.click(screen.getByTestId('totp-disable-open'));
    expect(screen.getByTestId('totp-disable-modal-open')).toBeTruthy();
  });

  it('비밀번호 변경 모달: 현재+새 비번 입력 후 제출 시 변경 mutation 호출', async () => {
    render(<AccountSettingsPage />);
    fireEvent.click(screen.getByTestId('account-change-password'));
    fireEvent.change(screen.getByTestId('change-password-current'), {
      target: { value: 'old-pass-1' },
    });
    fireEvent.change(screen.getByTestId('change-password-new'), {
      target: { value: 'new-strong-9' },
    });
    fireEvent.click(screen.getByTestId('change-password-submit'));
    await Promise.resolve();
    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: 'old-pass-1',
      newPassword: 'new-strong-9',
    });
  });

  it('비밀번호 변경: PASSWORD_INCORRECT 면 모달에 에러 표기', async () => {
    changePassword.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { errorCode: 'PASSWORD_INCORRECT' }),
    );
    render(<AccountSettingsPage />);
    fireEvent.click(screen.getByTestId('account-change-password'));
    fireEvent.change(screen.getByTestId('change-password-current'), {
      target: { value: 'wrong' },
    });
    fireEvent.change(screen.getByTestId('change-password-new'), {
      target: { value: 'new-strong-9' },
    });
    fireEvent.click(screen.getByTestId('change-password-submit'));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByTestId('change-password-error').textContent).toContain(
      '현재 비밀번호가 올바르지 않습니다',
    );
  });

  it('이메일 변경 모달: 비번+신규 이메일 제출 시 changeEmail 호출', async () => {
    render(<AccountSettingsPage />);
    fireEvent.click(screen.getByTestId('account-change-email'));
    fireEvent.change(screen.getByTestId('change-email-password'), {
      target: { value: 'old-pass-1' },
    });
    fireEvent.change(screen.getByTestId('change-email-input'), {
      target: { value: 'new@qufox.dev' },
    });
    fireEvent.click(screen.getByTestId('change-email-submit'));
    await Promise.resolve();
    expect(changeEmail).toHaveBeenCalledWith({
      currentPassword: 'old-pass-1',
      newEmail: 'new@qufox.dev',
    });
  });
});
