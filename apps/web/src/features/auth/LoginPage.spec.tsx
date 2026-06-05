// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const loginMock = vi.fn();
vi.mock('./AuthProvider', () => ({
  useAuth: () => ({ login: loginMock }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ state: null }),
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

const reactivateMock = vi.fn();
vi.mock('../settings/useSecurity', () => ({
  useReactivateAccount: () => ({ mutateAsync: reactivateMock, isPending: false }),
}));

// 브랜드 마크만 stub(폰트/이미지 로드 회피). Button/Input 은 실제 프리미티브를 쓴다 — Input 이
// forwardRef 로 react-hook-form 의 ref 를 받아야 폼 값이 올바로 수집되기 때문이다.
vi.mock('../../design-system/brand/BrandMark', () => ({ BrandMark: () => <div /> }));

import { LoginPage } from './LoginPage';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  loginMock.mockReset();
  navigateMock.mockReset();
  reactivateMock.mockReset();
  reactivateMock.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

async function submitLogin(email: string, password: string): Promise<void> {
  fireEvent.change(screen.getByTestId('login-email'), { target: { value: email } });
  fireEvent.change(screen.getByTestId('login-password'), { target: { value: password } });
  fireEvent.click(screen.getByTestId('login-submit'));
}

describe('LoginPage — ACCOUNT_DEACTIVATED 복구 CTA (FR-PS-16)', () => {
  it('로그인 시 ACCOUNT_DEACTIVATED → 복구 안내 + "계정 복구" CTA 노출', async () => {
    loginMock.mockRejectedValueOnce(
      Object.assign(new Error('account is deactivated'), { errorCode: 'ACCOUNT_DEACTIVATED' }),
    );
    render(<LoginPage />);
    await submitLogin('me@qufox.dev', 'Quanta-Beetle-Nebula-42!');
    await waitFor(() => expect(screen.getByTestId('login-deactivated-notice')).toBeTruthy());
    expect(screen.getByTestId('login-reactivate')).toBeTruthy();
  });

  it('복구 CTA 클릭 → reactivate 호출(입력 자격증명) → 재로그인 + 이동', async () => {
    loginMock.mockRejectedValueOnce(
      Object.assign(new Error('account is deactivated'), { errorCode: 'ACCOUNT_DEACTIVATED' }),
    );
    render(<LoginPage />);
    await submitLogin('me@qufox.dev', 'Quanta-Beetle-Nebula-42!');
    await waitFor(() => screen.getByTestId('login-reactivate'));

    // 복구 후 재로그인은 성공한다고 가정.
    loginMock.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByTestId('login-reactivate'));

    await waitFor(() =>
      expect(reactivateMock).toHaveBeenCalledWith({
        email: 'me@qufox.dev',
        password: 'Quanta-Beetle-Nebula-42!',
      }),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
  });

  it('일반 자격증명 오류는 복구 CTA 를 노출하지 않는다', async () => {
    loginMock.mockRejectedValueOnce(
      Object.assign(new Error('invalid credentials'), {
        errorCode: 'AUTH_INVALID_CREDENTIALS',
      }),
    );
    render(<LoginPage />);
    await submitLogin('me@qufox.dev', 'wrong');
    await waitFor(() => expect(screen.getByTestId('login-error')).toBeTruthy());
    expect(screen.queryByTestId('login-reactivate')).toBeNull();
  });

  // CF2 (a11y BLK-01): 서버 에러 라이브영역(role="alert")으로 SR 즉시 통지.
  it('CF2 — 서버 에러 메시지는 role="alert" 라이브영역으로 노출된다', async () => {
    loginMock.mockRejectedValueOnce(
      Object.assign(new Error('invalid credentials'), {
        errorCode: 'AUTH_INVALID_CREDENTIALS',
      }),
    );
    render(<LoginPage />);
    await submitLogin('me@qufox.dev', 'wrong');
    await waitFor(() => expect(screen.getByTestId('login-error')).toBeTruthy());
    expect(screen.getByTestId('login-error').getAttribute('role')).toBe('alert');
  });

  // CF8 (a11y HIGH-03): ACCOUNT_DEACTIVATED 통지 후 "계정 복구" 버튼으로 포커스 이동.
  it('CF8 — 비활성 안내가 뜨면 "계정 복구" 버튼으로 포커스가 이동한다', async () => {
    loginMock.mockRejectedValueOnce(
      Object.assign(new Error('account is deactivated'), { errorCode: 'ACCOUNT_DEACTIVATED' }),
    );
    render(<LoginPage />);
    await submitLogin('me@qufox.dev', 'Quanta-Beetle-Nebula-42!');
    const btn = await screen.findByTestId('login-reactivate');
    await waitFor(() => expect(document.activeElement).toBe(btn));
  });
});
