// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * S66 fix-forward (contract-LOW): 초대 수락 시 403 진입 게이트 사유별 안내를 검증한다.
 * useWorkspaces 훅과 AuthProvider 를 모킹해 QueryClient 없이 컴포넌트만 렌더한다.
 */

const acceptMutateAsync = vi.fn();
vi.mock('./useWorkspaces', () => ({
  useInvitePreview: () => ({
    data: { workspace: { name: 'Acme', slug: 'acme' }, expiresAt: null, usesRemaining: null },
    isLoading: false,
    error: null,
  }),
  useAcceptInvite: () => ({ mutateAsync: acceptMutateAsync, isPending: false }),
}));

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ status: 'authenticated' }),
}));

import { InviteAcceptPage } from './InviteAcceptPage';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  acceptMutateAsync.mockReset();
});

afterEach(() => cleanup());

function renderAt(code: string) {
  return render(
    <MemoryRouter initialEntries={[`/invite/${code}`]}>
      <Routes>
        <Route path="/invite/:code" element={<InviteAcceptPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InviteAcceptPage — 403 진입 게이트 분기 (contract-LOW)', () => {
  it('EMAIL_NOT_VERIFIED 면 인증 안내 문구를 보여준다', async () => {
    acceptMutateAsync.mockRejectedValue(
      Object.assign(new Error('forbidden'), { errorCode: 'EMAIL_NOT_VERIFIED' }),
    );
    renderAt('abc');
    fireEvent.click(screen.getByTestId('invite-accept'));
    await vi.waitFor(() =>
      expect(screen.getByTestId('invite-accept-error').textContent).toContain(
        '이메일 인증 후 초대를 수락',
      ),
    );
  });

  it('WORKSPACE_DOMAIN_NOT_ALLOWED 면 도메인 제한 안내 문구를 보여준다', async () => {
    acceptMutateAsync.mockRejectedValue(
      Object.assign(new Error('forbidden'), { errorCode: 'WORKSPACE_DOMAIN_NOT_ALLOWED' }),
    );
    renderAt('abc');
    fireEvent.click(screen.getByTestId('invite-accept'));
    await vi.waitFor(() =>
      expect(screen.getByTestId('invite-accept-error').textContent).toContain(
        '허용된 이메일 도메인',
      ),
    );
  });

  it('알 수 없는 오류는 일반 안내 문구로 분기한다', async () => {
    acceptMutateAsync.mockRejectedValue(
      Object.assign(new Error('boom'), { errorCode: 'SOME_OTHER' }),
    );
    renderAt('abc');
    fireEvent.click(screen.getByTestId('invite-accept'));
    await vi.waitFor(() =>
      expect(screen.getByTestId('invite-accept-error').textContent).toContain(
        '초대를 수락할 수 없습니다',
      ),
    );
  });
});
