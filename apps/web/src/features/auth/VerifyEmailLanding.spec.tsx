// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * S66 fix-forward (a11y/m3/MEDIUM-3): 이메일 인증 랜딩의 결과 라이브 영역(status/alert),
 * 진입 포커스, document.title, 토큰 URL strip, success 시 refreshMe 호출을 검증한다.
 */

const verifyEmailToken = vi.fn();
vi.mock('../../lib/api', () => ({
  verifyEmailToken: (...args: unknown[]) => verifyEmailToken(...args),
}));

const refreshMe = vi.fn();
let authStatus = 'authenticated';
vi.mock('./AuthProvider', () => ({
  useAuth: () => ({ status: authStatus, refreshMe }),
}));

import { VerifyEmailLanding } from './VerifyEmailLanding';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  verifyEmailToken.mockReset();
  refreshMe.mockReset();
  authStatus = 'authenticated';
});

afterEach(() => cleanup());

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/verify-email${search}`]}>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailLanding />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('VerifyEmailLanding (FR-W05b) fix-forward', () => {
  it('성공 시 success 라이브 영역(status) + document.title 갱신 + refreshMe 호출', async () => {
    verifyEmailToken.mockResolvedValue({ emailVerified: true });
    refreshMe.mockResolvedValue(true);
    renderAt('?token=00000000-0000-4000-8000-000000000000');
    await vi.waitFor(() => expect(screen.getByText('이메일 인증이 완료되었습니다')).toBeTruthy());
    // (A4) 결과가 polite status 컨테이너 안에 있다.
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    // (C3) 성공 타이틀. document.title 은 status별 useEffect(passive effect)로 갱신되므로,
    // success 텍스트 commit 직후 같은 tick 에 즉시 단언하면 effect flush 전 pending 타이틀을
    // 읽는 race 가 있다(전체 스위트 스케줄링에서 표면화). waitFor 로 effect flush 를 기다린다.
    await vi.waitFor(() => expect(document.title).toBe('이메일 인증 완료 | qufox'));
    // (m3) 로그인 세션이면 refreshMe 로 stale 게이트 해제.
    await vi.waitFor(() => expect(refreshMe).toHaveBeenCalledTimes(1));
  });

  it('만료 토큰은 alert(assertive) 컨테이너로 고지한다', async () => {
    verifyEmailToken.mockRejectedValue(
      Object.assign(new Error('expired'), { errorCode: 'EMAIL_VERIFICATION_TOKEN_EXPIRED' }),
    );
    renderAt('?token=00000000-0000-4000-8000-000000000000');
    await vi.waitFor(() => expect(screen.getByText('인증 링크를 사용할 수 없어요')).toBeTruthy());
    const region = screen.getByRole('alert');
    expect(region.getAttribute('aria-live')).toBe('assertive');
    expect(screen.getByTestId('verify-landing-error').textContent).toContain('만료');
    // 성공 타이틀과 동일한 passive-effect race 회피(waitFor).
    await vi.waitFor(() => expect(document.title).toBe('인증 링크 오류 | qufox'));
  });

  it('토큰 없으면 invalid 분기로 안내한다', async () => {
    renderAt('');
    await vi.waitFor(() =>
      expect(screen.getByTestId('verify-landing-error').textContent).toContain('유효하지 않습니다'),
    );
    expect(verifyEmailToken).not.toHaveBeenCalled();
  });

  it('토큰 추출 직후 URL 에서 ?token= 을 제거한다 (MEDIUM-3)', async () => {
    verifyEmailToken.mockResolvedValue({ emailVerified: true });
    refreshMe.mockResolvedValue(true);
    renderAt('?token=00000000-0000-4000-8000-000000000000');
    // history.replaceState 로 query 가 제거돼 pathname 만 남는다.
    await vi.waitFor(() => expect(window.location.search).toBe(''));
    // 검증에는 추출해둔 토큰을 쓴다(콜은 정상 수행).
    expect(verifyEmailToken).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000000');
  });
});
