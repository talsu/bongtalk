// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * AUTH-3 (PRD D18 §5 / FR-AUTH-41·42): ResetPasswordPage. StrengthMeter·qf-notice--warn·성공
 * navigate·만료/무효 안내(qf-notice--danger + 다시 요청)·?token= URL strip 을 검증한다.
 */

const resetPassword = vi.fn();
vi.mock('../../lib/api', () => ({
  resetPassword: (...args: unknown[]) => resetPassword(...args),
}));

const navigateMock = vi.fn();
let searchParam = '?token=11111111-1111-4111-8111-111111111111';
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(searchParam)],
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

vi.mock('../../design-system/brand/BrandMark', () => ({ BrandMark: () => <div /> }));

import { ResetPasswordPage } from './ResetPasswordPage';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  resetPassword.mockReset();
  navigateMock.mockReset();
  searchParam = '?token=11111111-1111-4111-8111-111111111111';
  // 각 테스트 전 URL 을 토큰이 실린 상태로 되돌린다(history.replaceState strip 검증용).
  window.history.replaceState(null, '', `/reset-password${searchParam}`);
});
afterEach(() => cleanup());

async function submitPassword(pw: string): Promise<void> {
  fireEvent.change(screen.getByTestId('reset-password'), { target: { value: pw } });
  fireEvent.click(screen.getByTestId('reset-submit'));
}

describe('ResetPasswordPage (FR-AUTH-41·42)', () => {
  it('StrengthMeter 와 .qf-notice--warn 경고를 렌더한다', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByTestId('strength-meter')).toBeTruthy();
    const warn = screen.getByTestId('reset-warn-notice');
    expect(warn.className.includes('qf-notice')).toBe(true);
    expect(warn.className.includes('qf-notice--warn')).toBe(true);
    expect(screen.getByText('변경 후 모든 기기에서 다시 로그인이 필요해요.')).toBeTruthy();
  });

  it('랜딩 시 URL 에서 ?token= 을 제거한다(노출 완화)', async () => {
    render(<ResetPasswordPage />);
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('성공 시 "변경되었습니다" 후 /login 으로 이동한다', async () => {
    resetPassword.mockResolvedValue({ ok: true });
    render(<ResetPasswordPage />);
    await submitPassword('Reset-Brand-New-77!');
    await waitFor(() => expect(screen.getByTestId('reset-done')).toBeTruthy());
    expect(screen.getByText('변경되었습니다.')).toBeTruthy();
    // 추출해둔 토큰으로 reset 을 호출한다(URL 에서 제거됐어도).
    expect(resetPassword).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'Reset-Brand-New-77!',
    );
    fireEvent.click(screen.getByTestId('reset-go-login'));
    expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('만료 토큰은 .qf-notice--danger 안내 + 다시 요청 경로로 분기한다', async () => {
    resetPassword.mockRejectedValue(
      Object.assign(new Error('expired'), { errorCode: 'PASSWORD_RESET_TOKEN_EXPIRED' }),
    );
    render(<ResetPasswordPage />);
    await submitPassword('Reset-Brand-New-88!');
    const err = await screen.findByTestId('reset-token-error');
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.innerHTML.includes('qf-notice--danger')).toBe(true);
    // "다시 요청" 경로(react-router Link mock 은 children 만 렌더하므로 텍스트로 단언).
    expect(screen.getByText('재설정 링크 다시 요청')).toBeTruthy();
  });

  it('무효 토큰도 만료와 동일하게 다시 요청 경로로 분기한다', async () => {
    resetPassword.mockRejectedValue(
      Object.assign(new Error('invalid'), { errorCode: 'PASSWORD_RESET_TOKEN_INVALID' }),
    );
    render(<ResetPasswordPage />);
    await submitPassword('Reset-Brand-New-99!');
    await waitFor(() => expect(screen.getByTestId('reset-token-error')).toBeTruthy());
    expect(screen.getByText('재설정 링크 다시 요청')).toBeTruthy();
  });

  // AUTH-3 a11y (A1·A2·A3 · EmailVerificationGate 정본 패턴).
  it('a11y — document.title·section aria-labelledby·h1 tabIndex·eyebrow aria-hidden', () => {
    render(<ResetPasswordPage />);
    expect(document.title).toBe('새 비밀번호 설정 | qufox');
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.id).toBe('reset-heading');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    const section = document.querySelector('section[aria-labelledby="reset-heading"]');
    expect(section).not.toBeNull();
    const eyebrow = document.querySelector('.qf-eyebrow');
    expect(eyebrow?.getAttribute('aria-hidden')).toBe('true');
    expect(eyebrow?.textContent).toBe('qufox · reset');
  });

  // AUTH-3 a11y (A1·A4): done 전환 시 title=변경 완료 + heading 포커스 이동.
  it('a11y — done 전환 시 title 재설정·heading 포커스 이동', async () => {
    resetPassword.mockResolvedValue({ ok: true });
    render(<ResetPasswordPage />);
    await submitPassword('Reset-Brand-New-77!');
    await waitFor(() => expect(screen.getByTestId('reset-done')).toBeTruthy());
    await waitFor(() => expect(document.title).toBe('변경 완료 | qufox'));
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('변경 완료');
    expect(document.activeElement).toBe(heading);
  });

  // AUTH-3 a11y (A1·A4): token-error 전환 시 title=링크 오류 + heading 포커스 이동.
  it('a11y — token-error 전환 시 title 재설정·heading 포커스 이동', async () => {
    resetPassword.mockRejectedValue(
      Object.assign(new Error('expired'), { errorCode: 'PASSWORD_RESET_TOKEN_EXPIRED' }),
    );
    render(<ResetPasswordPage />);
    await submitPassword('Reset-Brand-New-88!');
    await screen.findByTestId('reset-token-error');
    await waitFor(() => expect(document.title).toBe('링크 오류 | qufox'));
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('링크 오류');
    expect(document.activeElement).toBe(heading);
  });
});

// AUTH-3 a11y (A5): 토큰 없는 직접 진입은 마운트 시 즉시 token-error 로 분기한다(빈 폼 노출 방지).
describe('ResetPasswordPage — 토큰 없는 직접 진입 (A5)', () => {
  beforeEach(() => {
    searchParam = '';
    window.history.replaceState(null, '', '/reset-password');
  });

  it('token 이 없으면 폼을 노출하지 않고 즉시 token-error 로 분기한다', () => {
    render(<ResetPasswordPage />);
    // 빈 폼(reset-password 입력)이 노출되지 않는다.
    expect(screen.queryByTestId('reset-password')).toBeNull();
    expect(screen.getByTestId('reset-token-error')).toBeTruthy();
    expect(document.title).toBe('링크 오류 | qufox');
  });
});
