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

  it('진입 시 라이브 영역(notice/error)이 DOM 에 존재하며 빈 상태로 유지된다 (A1)', () => {
    render(<EmailVerificationGate />);
    const notice = screen.getByTestId('verify-notice');
    const error = screen.getByTestId('verify-error');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.getAttribute('aria-live')).toBe('assertive');
    // 빈 상태로 DOM 유지(텍스트만 교체).
    expect(notice.textContent).toBe('');
    expect(error.textContent).toBe('');
  });

  // AUTH-1 (PRD D18 / C-3): "인증 메일 다시 보내기" 가 primary·첫 번째, "이미 인증했어요" 가
  // secondary·두 번째다(버튼 순서 반전).
  it('AUTH-1 — 재발송 버튼이 primary·첫 번째, "이미 인증했어요" 가 두 번째다', () => {
    render(<EmailVerificationGate />);
    const resend = screen.getByTestId('verify-resend');
    const already = screen.getByTestId('verify-already');
    // DOM 순서상 resend 가 already 보다 먼저 나타난다.
    const order = resend.compareDocumentPosition(already);
    expect(!!(order & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    // 재발송은 primary(secondary 클래스 없음), already 는 secondary.
    expect(resend.className.includes('qf-btn--secondary')).toBe(false);
    expect(already.className.includes('qf-btn--secondary')).toBe(true);
  });

  // AUTH-1 (PRD D18 / C-3): notice/error 에 DS .qf-notice 클래스를 적용한다.
  it('AUTH-1 — notice 는 .qf-notice, error 는 .qf-notice--danger 클래스를 갖는다', () => {
    render(<EmailVerificationGate />);
    expect(screen.getByTestId('verify-notice').className.includes('qf-notice')).toBe(true);
    const error = screen.getByTestId('verify-error');
    expect(error.className.includes('qf-notice')).toBe(true);
    expect(error.className.includes('qf-notice--danger')).toBe(true);
  });

  it('재발송 클릭 시 쿨다운을 시작하되 버튼 이름은 고정·카운트다운은 분리된다 (A2/B4)', async () => {
    resendVerificationEmail.mockResolvedValue({ cooldownSec: 60, remainingToday: 4 });
    render(<EmailVerificationGate />);
    const resendBtn = screen.getByTestId('verify-resend') as HTMLButtonElement;
    fireEvent.click(resendBtn);
    await vi.waitFor(() => expect(resendVerificationEmail).toHaveBeenCalledTimes(1));
    // (B4) HTML disabled 대신 aria-disabled — 포커스 유지.
    await vi.waitFor(() => {
      expect(screen.getByTestId('verify-resend').getAttribute('aria-disabled')).toBe('true');
    });
    // (A2) 버튼 이름(텍스트)에는 카운트다운 숫자가 없다.
    expect(screen.getByTestId('verify-resend').textContent).toBe('인증 메일 다시 보내기');
    // (A2) 카운트다운은 버튼 밖 aria-hidden span 에만 있다.
    const countdown = screen.getByTestId('verify-resend-countdown');
    expect(countdown.getAttribute('aria-hidden')).toBe('true');
    expect(countdown.textContent).toContain('60초');
    // (A2) 비활성 사유는 aria-label 로 전달.
    expect(screen.getByTestId('verify-resend').getAttribute('aria-label')).toContain(
      '60초 후 가능',
    );
    // 1초 경과 → 59(시각 카운트다운만 갱신).
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => {
      expect(screen.getByTestId('verify-resend-countdown').textContent).toContain('59초');
    });
  });

  it('일일 한도 소진(remainingToday=0)이면 영구 비활성 + 안내문구 (B4)', async () => {
    resendVerificationEmail.mockResolvedValue({ cooldownSec: 60, remainingToday: 0 });
    render(<EmailVerificationGate />);
    fireEvent.click(screen.getByTestId('verify-resend'));
    await vi.waitFor(() => expect(screen.getByTestId('verify-resend-exhausted')).toBeTruthy());
    expect(screen.getByTestId('verify-resend').getAttribute('aria-label')).toContain('한도');
  });

  it('checking/resending 시 aria-busy 를 켠다 (A3)', async () => {
    refreshMe.mockImplementation(() => new Promise(() => {})); // 영구 pending
    render(<EmailVerificationGate />);
    fireEvent.click(screen.getByTestId('verify-already'));
    await vi.waitFor(() => {
      expect(screen.getByTestId('verify-already').getAttribute('aria-busy')).toBe('true');
    });
  });

  it('AUTH-1(MED-2) — 로그아웃 버튼은 보이는 텍스트를 접근명으로 쓴다 (Label in Name·WCAG 2.5.3)', () => {
    render(<EmailVerificationGate />);
    const logout = screen.getByTestId('verify-logout');
    // 별도 aria-label("로그아웃 후 …")은 보이는 텍스트를 포함하지 않아 2.5.3 위반이라 제거.
    // 이제 보이는 텍스트 "다른 계정으로 로그인" 이 그대로 접근명(음성 제어와 일치).
    expect(logout.getAttribute('aria-label')).toBeNull();
    expect(logout.textContent).toBe('다른 계정으로 로그인');
  });

  it('"이미 인증했어요" 클릭 시 refreshMe 를 호출하고, 미인증이면 안내를 띄운다', async () => {
    refreshMe.mockResolvedValue(false);
    render(<EmailVerificationGate />);
    fireEvent.click(screen.getByTestId('verify-already'));
    await vi.waitFor(() => expect(refreshMe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(screen.getByTestId('verify-error').textContent).toContain('아직 인증이 확인되지'),
    );
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
    await vi.waitFor(() =>
      expect(screen.getByTestId('verify-error').textContent).toContain('잠시 후 다시 시도'),
    );
  });
});
