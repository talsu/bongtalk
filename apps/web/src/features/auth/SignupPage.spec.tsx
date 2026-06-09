// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * AUTH-1 (PRD D18): 가입 화면의 카피 교체(C-2)와 비밀번호 강도 미터(C-6) 렌더를
 * jsdom 으로 검증한다. jest-dom 미사용 — plain 매처만 쓴다.
 */

const signupMock = vi.fn();
vi.mock('./AuthProvider', () => ({
  useAuth: () => ({ signup: signupMock }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

// 브랜드 마크만 stub. Button/Input/StrengthMeter 는 실제 프리미티브 — Input 의 forwardRef 가
// react-hook-form 의 ref/onChange 를 받아야 watch('password') 가 동작한다.
vi.mock('../../design-system/brand/BrandMark', () => ({ BrandMark: () => <div /> }));

import { SignupPage } from './SignupPage';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  signupMock.mockReset();
  navigateMock.mockReset();
});
afterEach(() => cleanup());

describe('SignupPage (AUTH-1 / PRD D18)', () => {
  it('C-2 — 제목/부제목 카피가 교체되었다', () => {
    render(<SignupPage />);
    expect(screen.getByText('qufox에 오신 걸 환영해요')).toBeTruthy();
    expect(screen.getByText('1분이면 대화를 시작할 수 있어요.')).toBeTruthy();
  });

  it('C-6/HIGH-2 — 비밀번호가 비면 미터는 막대·라벨텍스트 없이 라이브영역만 유지한다', () => {
    render(<SignupPage />);
    // HIGH-2: 첫 글자 입력 전환을 SR 이 고지하도록 라이브영역(라벨)을 DOM 에 유지하되,
    // 막대 없음 + 라벨 텍스트 빈 + data-strength="empty" 로 시각 중립.
    const meter = screen.getByTestId('strength-meter');
    expect(meter.getAttribute('data-strength')).toBe('empty');
    expect(screen.queryAllByTestId('strength-bar').length).toBe(0);
    expect(screen.getByTestId('strength-label').textContent).toBe('');
  });

  it('C-6 — 비밀번호 입력 시 강도 미터가 실시간으로 나타난다', async () => {
    render(<SignupPage />);
    fireEvent.change(screen.getByTestId('signup-password'), {
      target: { value: 'Abcdef123456' },
    });
    const meter = await screen.findByTestId('strength-meter');
    expect(meter.getAttribute('data-strength')).toBe('strong');
    expect(screen.getByTestId('strength-label').textContent).toContain('강함');
  });

  it('C-6 — 약한 비밀번호는 weak 으로 표시된다', async () => {
    render(<SignupPage />);
    fireEvent.change(screen.getByTestId('signup-password'), { target: { value: 'abcdefg' } });
    const meter = await screen.findByTestId('strength-meter');
    expect(meter.getAttribute('data-strength')).toBe('weak');
  });
});
