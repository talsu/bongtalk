// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

/**
 * S66 (D13 / FR-W05b): 이메일 인증 대기 화면. 카피·재발송 쿨다운 카운트다운·"이미
 * 인증했어요" 동작을 jsdom 으로 검증한다(AuthProvider·api 모킹).
 */

const refreshMe = vi.fn();
const logout = vi.fn();
vi.mock('./AuthProvider', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: { id: 'u1', email: 'a@acme.com', username: 'alice', emailVerified: false },
    refreshMe,
    logout,
    login: vi.fn(),
    signup: vi.fn(),
  }),
}));

const resendVerificationEmail = vi.fn();
vi.mock('../../lib/api', () => ({
  resendVerificationEmail: (...args: unknown[]) => resendVerificationEmail(...args),
}));

// BrandMark·Button 은 실제 컴포넌트 사용(DS primitives) — 모킹 불요.
import { EmailVerificationGate } from './EmailVerificationGate';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  refreshMe.mockReset();
  logout.mockReset();
  resendVerificationEmail.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('EmailVerificationGate (FR-W05b)', () => {
  it('카피와 사용자 이메일을 렌더한다', () => {
    render(<EmailVerificationGate />);
    expect(screen.getByTestId('verify-email-gate')).toBeTruthy();
    expect(screen.getByText('인증 메일을 보냈습니다. 받은 편지함을 확인해 주세요.')).toBeTruthy();
    expect(screen.getByText('a@acme.com')).toBeTruthy();
  });

  it('재발송 클릭 시 60초 쿨다운 카운트다운을 시작한다', async () => {
    resendVerificationEmail.mockResolvedValue({ cooldownSec: 60, remainingToday: 4 });
    render(<EmailVerificationGate />);
    const resendBtn = screen.getByTestId('verify-resend') as HTMLButtonElement;
    fireEvent.click(resendBtn);
    await vi.waitFor(() => expect(resendVerificationEmail).toHaveBeenCalledTimes(1));
    // 쿨다운 시작 → 버튼 disabled + 카운트다운 표기.
    await vi.waitFor(() => {
      expect((screen.getByTestId('verify-resend') as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.getByTestId('verify-resend').textContent).toContain('60초 후 가능');
    // 1초 경과 → 59.
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => {
      expect(screen.getByTestId('verify-resend').textContent).toContain('59초 후 가능');
    });
  });

  it('"이미 인증했어요" 클릭 시 refreshMe 를 호출하고, 미인증이면 안내를 띄운다', async () => {
    refreshMe.mockResolvedValue(false);
    render(<EmailVerificationGate />);
    fireEvent.click(screen.getByTestId('verify-already'));
    await vi.waitFor(() => expect(refreshMe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(screen.getByTestId('verify-error')).toBeTruthy());
  });

  it('429 응답이면 rate-limited 안내를 띄운다', async () => {
    resendVerificationEmail.mockRejectedValue(
      Object.assign(new Error('rl'), {
        errorCode: 'EMAIL_VERIFICATION_RATE_LIMITED',
        retryAfterSec: 30,
      }),
    );
    render(<EmailVerificationGate />);
    fireEvent.click(screen.getByTestId('verify-resend'));
    await vi.waitFor(() => expect(screen.getByTestId('verify-error')).toBeTruthy());
  });
});
