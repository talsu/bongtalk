// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * AUTH-3 (PRD D18 §5 / FR-AUTH-40): ForgotPasswordPage. 제출 후 항상 동일한 확인 화면
 * (존재 여부 비노출 — 열거 방어)·role=status·확인 메시지를 검증한다.
 */

const forgotPassword = vi.fn();
vi.mock('../../lib/api', () => ({
  forgotPassword: (...args: unknown[]) => forgotPassword(...args),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

// 브랜드 마크만 stub. Button/Input 은 실제 프리미티브(forwardRef ref 수집을 위해).
vi.mock('../../design-system/brand/BrandMark', () => ({ BrandMark: () => <div /> }));

import { ForgotPasswordPage } from './ForgotPasswordPage';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  forgotPassword.mockReset();
});
afterEach(() => cleanup());

async function submitEmail(email: string): Promise<void> {
  fireEvent.change(screen.getByTestId('forgot-email'), { target: { value: email } });
  fireEvent.click(screen.getByTestId('forgot-submit'));
}

describe('ForgotPasswordPage (FR-AUTH-40)', () => {
  it('제출 후 동일한 확인 화면(role=status)으로 전환한다', async () => {
    forgotPassword.mockResolvedValue({ ok: true });
    render(<ForgotPasswordPage />);
    await submitEmail('me@qufox.dev');
    const sent = await screen.findByTestId('forgot-sent');
    expect(sent.getAttribute('role')).toBe('status');
    expect(screen.getByText('입력하신 주소로 메일을 보냈어요.')).toBeTruthy();
    expect(forgotPassword).toHaveBeenCalledWith('me@qufox.dev');
  });

  // AUTH-3 a11y (A1·A2·A3 · EmailVerificationGate 정본 패턴).
  it('a11y — document.title·section aria-labelledby·h1 tabIndex·eyebrow aria-hidden', () => {
    render(<ForgotPasswordPage />);
    // (A1) 마운트 시 폼 단계 title.
    expect(document.title).toBe('비밀번호 찾기 | qufox');
    // (A2) section[aria-labelledby] 가 h1[id] 를 가리킨다.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.id).toBe('forgot-heading');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    const section = document.querySelector('section[aria-labelledby="forgot-heading"]');
    expect(section).not.toBeNull();
    // (A3) 장식 eyebrow 는 aria-hidden.
    const eyebrow = document.querySelector('.qf-eyebrow');
    expect(eyebrow?.getAttribute('aria-hidden')).toBe('true');
    expect(eyebrow?.textContent).toBe('qufox · forgot');
  });

  // AUTH-3 a11y (A1·A4): sent 전환 시 title 재설정 + heading 텍스트 갱신(LOW-1) + 포커스 이동.
  it('a11y — sent 전환 시 title 재설정·heading 갱신·heading 포커스 이동', async () => {
    forgotPassword.mockResolvedValue({ ok: true });
    render(<ForgotPasswordPage />);
    await submitEmail('me@qufox.dev');
    await screen.findByTestId('forgot-sent');
    // (A1) sent title.
    await waitFor(() => expect(document.title).toBe('메일 발송 완료 | qufox'));
    // (A4·LOW-1) heading 텍스트가 확인화면과 정합하고 포커스를 받는다.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('메일을 보냈어요');
    expect(document.activeElement).toBe(heading);
  });

  it('서버 오류여도 동일한 확인 화면을 보여준다(존재 여부 비노출 — 열거 방어)', async () => {
    forgotPassword.mockRejectedValue(new Error('boom'));
    render(<ForgotPasswordPage />);
    await submitEmail('unknown@qufox.dev');
    // 성공/실패 분기 없이 항상 동일한 확인 화면(열거 방어).
    await waitFor(() => expect(screen.getByTestId('forgot-sent')).toBeTruthy());
    expect(screen.getByText('입력하신 주소로 메일을 보냈어요.')).toBeTruthy();
  });

  it('확인 화면에는 입력 폼이 더 이상 보이지 않는다', async () => {
    forgotPassword.mockResolvedValue({ ok: true });
    render(<ForgotPasswordPage />);
    await submitEmail('me@qufox.dev');
    await screen.findByTestId('forgot-sent');
    expect(screen.queryByTestId('forgot-submit')).toBeNull();
  });
});
