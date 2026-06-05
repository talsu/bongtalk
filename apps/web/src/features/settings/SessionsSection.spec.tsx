// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionListResponse } from '@qufox/shared-types';

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

let data: SessionListResponse | undefined;
let isLoading: boolean;
let isError: boolean;
const revokeMutate = vi.fn();
const revokeAllMutate = vi.fn();
vi.mock('./useSecurity', () => ({
  useSessions: () => ({ data, isLoading, isError }),
  useRevokeSession: () => ({ mutateAsync: revokeMutate, isPending: false }),
  useRevokeAllSessions: () => ({ mutateAsync: revokeAllMutate, isPending: false }),
}));

import { SessionsSection } from './SessionsSection';

const SESSIONS: SessionListResponse = {
  sessions: [
    {
      id: 's-current',
      deviceName: 'Chrome · macOS',
      ip: '1.2.3.4',
      userAgent: 'ua',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastSeenAt: '2025-01-02T00:00:00.000Z',
      isCurrent: true,
    },
    {
      id: 's-other',
      deviceName: 'Firefox · Windows',
      ip: '5.6.7.8',
      userAgent: 'ua2',
      createdAt: '2024-12-30T00:00:00.000Z',
      lastSeenAt: null,
      isCurrent: false,
    },
  ],
};

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  data = SESSIONS;
  isLoading = false;
  isError = false;
  pushMock.mockReset();
  revokeMutate.mockReset();
  revokeMutate.mockResolvedValue(undefined);
  revokeAllMutate.mockReset();
  revokeAllMutate.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('SessionsSection (FR-PS-15)', () => {
  it('현재 기기 배지를 표시하고 현재 세션엔 로그아웃 버튼이 없다', () => {
    render(<SessionsSection />);
    expect(screen.getByTestId('session-current-badge')).toBeTruthy();
    expect(screen.queryByTestId('session-revoke-s-current')).toBeNull();
    expect(screen.getByTestId('session-revoke-s-other')).toBeTruthy();
  });

  it('개별 로그아웃 → revokeSession 호출', async () => {
    render(<SessionsSection />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('session-revoke-s-other'));
    });
    expect(revokeMutate).toHaveBeenCalledWith('s-other');
  });

  it('다른 기기 모두 로그아웃 → revokeAll 호출', async () => {
    render(<SessionsSection />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sessions-revoke-all'));
    });
    expect(revokeAllMutate).toHaveBeenCalled();
  });

  it('다른 세션이 없으면 전체 로그아웃 버튼을 숨긴다', () => {
    data = { sessions: [SESSIONS.sessions[0]] };
    render(<SessionsSection />);
    expect(screen.queryByTestId('sessions-revoke-all')).toBeNull();
  });

  it('로딩/에러 상태를 표시한다', () => {
    isLoading = true;
    data = undefined;
    const { rerender } = render(<SessionsSection />);
    expect(screen.getByText('불러오는 중…')).toBeTruthy();
    isLoading = false;
    isError = true;
    rerender(<SessionsSection />);
    expect(screen.getByText('세션을 불러올 수 없습니다.')).toBeTruthy();
  });
});
