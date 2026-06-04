// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Invite } from '@qufox/shared-types';

// S67 fix-forward RTL (a11y B-1·S-1·S-2·S-3·M-1): Dialog/Button pass-through 모킹으로
// Radix portal 을 회피하고, useWorkspaces 초대 hooks 를 모킹해 hard-delete 확인 다이얼로그·
// 액션 버튼 aria-label·복사 라이브영역·aria-busy·dl 시맨틱을 검증한다.
vi.mock('../../design-system/primitives', () => ({
  Dialog: ({
    children,
    open,
    title,
    description,
    alertDialog,
  }: {
    children?: ReactNode;
    open?: boolean;
    title?: string;
    description?: string;
    alertDialog?: boolean;
  }) =>
    open ? (
      <div role={alertDialog ? 'alertdialog' : 'dialog'} aria-label={title}>
        {description ? <p data-testid="dialog-description">{description}</p> : null}
        {children}
      </div>
    ) : null,
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

const revokeMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
const hardDeleteMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
let invitesData: { invites: Invite[] } | undefined;
let invitesLoading = false;

vi.mock('./useWorkspaces', () => ({
  useInvites: () => ({ data: invitesData, isLoading: invitesLoading }),
  useRevokeInvite: () => revokeMut,
  useHardDeleteInvite: () => hardDeleteMut,
}));

// CreateInviteModal 은 별도 spec 으로 검증 — 여기선 no-op 으로 둔다.
vi.mock('./CreateInviteModal', () => ({
  CreateInviteModal: () => null,
}));

import { InviteManagerPanel } from './InviteManagerPanel';

const INV: Invite = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'ABCD2345',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  createdById: '33333333-3333-4333-8333-333333333333',
  expiresAt: '2025-01-08T00:00:00.000Z',
  maxUses: 5,
  usedCount: 2,
  revokedAt: null,
  temporary: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  url: 'http://localhost:45173/invite/ABCD2345',
  usesRemaining: 3,
  active: true,
  createdBy: { id: '33333333-3333-4333-8333-333333333333', username: 'alice' },
};

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  // 전 테스트 공통 fake timers — setSystemTime 보다 먼저 호출해야 한다(순서 역전 시
  // "date was mocked" 에러). 타이머 의존 테스트(S-2·perf 5d)는 advanceTimersByTimeAsync
  // 로 명시 진행하고, 그 외엔 마이크로태스크만 flush 한다.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  invitesData = { invites: [INV] };
  invitesLoading = false;
  revokeMut.mutateAsync.mockClear();
  hardDeleteMut.mutateAsync.mockClear();
  hardDeleteMut.isPending = false;
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup();
});

describe('S67 InviteManagerPanel fix-forward', () => {
  it('(a11y S-3) 컨테이너에 aria-busy/aria-live 가 붙고 로딩 시 true 입니다', () => {
    invitesLoading = true;
    render(<InviteManagerPanel workspaceId="ws-1" />);
    const container = screen.getByTestId('invite-manager');
    expect(container.getAttribute('aria-busy')).toBe('true');
    expect(container.getAttribute('aria-live')).toBe('polite');
  });

  it('(a11y S-1) 행 액션 버튼에 대상 코드 명시 aria-label 이 붙습니다', () => {
    render(<InviteManagerPanel workspaceId="ws-1" />);
    expect(screen.getByTestId('invite-copy').getAttribute('aria-label')).toBe(
      '초대 코드 ABCD2345 링크 복사',
    );
    expect(screen.getByTestId('invite-revoke').getAttribute('aria-label')).toBe(
      '초대 코드 ABCD2345 비활성화',
    );
    expect(screen.getByTestId('invite-hard-delete').getAttribute('aria-label')).toBe(
      '초대 코드 ABCD2345 영구 삭제',
    );
  });

  it('(a11y M-1) 목록 메타는 dl/dt/dd 시맨틱으로 렌더됩니다', () => {
    const { container } = render(<InviteManagerPanel workspaceId="ws-1" />);
    expect(container.querySelector('dl')).not.toBeNull();
    expect(container.querySelectorAll('dt').length).toBeGreaterThanOrEqual(6);
    expect(container.querySelectorAll('dd').length).toBeGreaterThanOrEqual(6);
  });

  it('(a11y B-1) 영구 삭제는 즉시 실행하지 않고 alertDialog 확인을 거칩니다', async () => {
    render(<InviteManagerPanel workspaceId="ws-1" />);
    // 첫 클릭은 확인 다이얼로그만 연다(즉시 삭제 X).
    fireEvent.click(screen.getByTestId('invite-hard-delete'));
    expect(hardDeleteMut.mutateAsync).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByTestId('dialog-description').textContent).toContain('ABCD2345');
    expect(within(dialog).getByTestId('dialog-description').textContent).toContain(
      '되돌릴 수 없습니다',
    );
    // 확인 버튼 클릭 → 실제 삭제 호출(마이크로태스크 flush).
    fireEvent.click(screen.getByTestId('invite-hard-delete-confirm-submit'));
    await vi.advanceTimersByTimeAsync(0);
    expect(hardDeleteMut.mutateAsync).toHaveBeenCalledWith(INV.id);
  });

  it('(a11y S-2) 복사 시 sr-only 라이브영역에 안내가 표시되고 2초 후 비워집니다', async () => {
    render(<InviteManagerPanel workspaceId="ws-1" />);
    fireEvent.click(screen.getByTestId('invite-copy'));
    // 클립보드 write 마이크로태스크를 flush.
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith(INV.url);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('ABCD2345');
    // 2초 경과 → 비워짐.
    await vi.advanceTimersByTimeAsync(2000);
    expect(status.textContent).toBe('');
  });

  it('(perf 5d) unmount 시 복사 타이머를 정리해 setState 누수가 없습니다', async () => {
    const { unmount } = render(<InviteManagerPanel workspaceId="ws-1" />);
    fireEvent.click(screen.getByTestId('invite-copy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalled();
    // unmount 후 타이머가 돌아도 throw 가 없어야 한다(cleanup useEffect 가 clearTimeout).
    // 정리되지 않은 setTimeout 이 unmount 된 컴포넌트에 setState 하면 React 가 경고를 내거나
    // 후속 렌더에서 깨진다 — clearTimeout 으로 그 타이머 자체가 없어야 한다.
    unmount();
    await vi.advanceTimersByTimeAsync(2000);
    // 타이머가 정리됐으면 진행 후 남은 타이머가 없다.
    expect(vi.getTimerCount()).toBe(0);
  });
});
