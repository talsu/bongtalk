// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { WorkspaceMemberApplication } from '@qufox/shared-types';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const pushNotify = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushNotify }) => unknown) => sel({ push: pushNotify }),
}));

vi.mock('../../design-system/primitives', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    [k: string]: unknown;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

const withdrawMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
let myApplication: { data: { application: WorkspaceMemberApplication | null }; isLoading: boolean };
vi.mock('./useApplications', () => ({
  useMyApplication: () => myApplication,
  useWithdrawApplication: () => withdrawMut,
}));

import { ApplicationPendingPage } from './ApplicationPendingPage';

function app(over: Partial<WorkspaceMemberApplication> = {}): WorkspaceMemberApplication {
  return {
    id: 'app-1',
    workspaceId: 'ws-1',
    applicantId: 'u-1',
    status: 'PENDING',
    answers: [],
    reviewedById: null,
    reviewNote: null,
    interviewChannelId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  navigate.mockReset();
  pushNotify.mockReset();
  withdrawMut.mutateAsync.mockReset().mockResolvedValue(undefined);
  myApplication = { data: { application: app() }, isLoading: false };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('S70 ApplicationPendingPage (FR-W06a)', () => {
  it('PENDING 이면 접수 카피 + 취소 버튼을 보여준다', () => {
    render(<ApplicationPendingPage slug="acme" />);
    expect(screen.getByTestId('application-pending')).toBeTruthy();
    expect(screen.getByTestId('application-cancel')).toBeTruthy();
  });

  it('취소 클릭 시 withdraw mutation 을 호출한다', () => {
    render(<ApplicationPendingPage slug="acme" />);
    fireEvent.click(screen.getByTestId('application-cancel'));
    expect(withdrawMut.mutateAsync).toHaveBeenCalledWith('app-1');
  });

  it('rejected + reviewNote 이면 거절 카피 + reviewNote + 재신청/탐색 버튼을 노출한다', () => {
    myApplication = {
      data: { application: app({ status: 'REJECTED', reviewNote: '경험이 더 필요합니다' }) },
      isLoading: false,
    };
    render(<ApplicationPendingPage slug="acme" />);
    expect(screen.getByTestId('application-rejected')).toBeTruthy();
    expect(screen.getByTestId('application-review-note').textContent).toContain(
      '경험이 더 필요합니다',
    );
    expect(screen.getByTestId('application-reapply')).toBeTruthy();
    expect(screen.getByTestId('application-discover')).toBeTruthy();
  });

  it('discover 버튼은 /discover 로 이동한다', () => {
    myApplication = { data: { application: app({ status: 'REJECTED' }) }, isLoading: false };
    render(<ApplicationPendingPage slug="acme" />);
    fireEvent.click(screen.getByTestId('application-discover'));
    expect(navigate).toHaveBeenCalledWith('/discover');
  });

  it('approved 이면 토스트 후 2초 뒤 워크스페이스로 자동 이동한다', () => {
    myApplication = { data: { application: app({ status: 'APPROVED' }) }, isLoading: false };
    render(<ApplicationPendingPage slug="acme" workspacePath="/w/acme" />);
    expect(screen.getByTestId('application-approved')).toBeTruthy();
    expect(pushNotify).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
    expect(navigate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(navigate).toHaveBeenCalledWith('/w/acme');
  });

  it('WS ws:application_reviewed(rejected) 이벤트를 받으면 거절 화면으로 전환한다', () => {
    render(<ApplicationPendingPage slug="acme" />);
    expect(screen.getByTestId('application-pending')).toBeTruthy();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('qufox.application.reviewed', {
          detail: {
            workspaceId: 'ws-1',
            applicationId: 'app-1',
            status: 'rejected',
            reviewNote: '다음 기회에',
          },
        }),
      );
    });
    expect(screen.getByTestId('application-rejected')).toBeTruthy();
    expect(screen.getByTestId('application-review-note').textContent).toContain('다음 기회에');
  });
});
