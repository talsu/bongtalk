// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PendingInvite } from '@qufox/shared-types';

vi.mock('../../design-system/primitives', () => ({
  Dialog: ({
    children,
    open,
    title,
    alertDialog,
  }: {
    children?: ReactNode;
    open?: boolean;
    title?: string;
    alertDialog?: boolean;
  }) =>
    open ? (
      <div role={alertDialog ? 'alertdialog' : 'dialog'} aria-label={title}>
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
  // S68 fix-forward: 만료 라벨이 ⚠ Icon(aria-hidden)을 쓰므로 mock 에 추가한다.
  Icon: ({ name }: { name: string }) => <svg data-testid={`icon-${name}`} aria-hidden="true" />,
}));

const updateMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
const cancelMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
let pendingData: { pending: PendingInvite[] } | undefined;

vi.mock('./useEmailInvites', () => ({
  usePendingInvites: () => ({ data: pendingData, isLoading: false }),
  useUpdatePendingInvite: () => updateMut,
  useCancelPendingInvite: () => cancelMut,
}));

import { PendingInvitePanel } from './PendingInvitePanel';

const ROW: PendingInvite = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  email: 'p@acme.com',
  role: 'MEMBER',
  expiresAt: '2025-02-01T00:00:00.000Z',
  lastSentAt: '2025-01-01T00:00:00.000Z',
  createdAt: '2025-01-01T00:00:00.000Z',
  expired: false,
  invitedBy: { id: '00000000-0000-4000-8000-000000000003', username: 'admin' },
};

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  updateMut.mutateAsync.mockReset().mockResolvedValue(undefined);
  cancelMut.mutateAsync.mockReset().mockResolvedValue(undefined);
  pendingData = { pending: [ROW] };
});
afterEach(() => cleanup());

describe('S68 PendingInvitePanel (FR-W18)', () => {
  it('renders a pending invite row with its email + role', () => {
    render(<PendingInvitePanel workspaceId="ws" />);
    expect(screen.getByText('p@acme.com')).toBeTruthy();
    expect(screen.getByTestId('pending-invite-status').textContent).toContain('대기 중');
  });

  it('extends an invite (+30일)', () => {
    render(<PendingInvitePanel workspaceId="ws" />);
    fireEvent.click(screen.getByTestId('pending-invite-extend'));
    expect(updateMut.mutateAsync).toHaveBeenCalledWith({ pendingId: ROW.id, action: 'EXTEND' });
  });

  it('resends an invite', () => {
    render(<PendingInvitePanel workspaceId="ws" />);
    fireEvent.click(screen.getByTestId('pending-invite-resend'));
    expect(updateMut.mutateAsync).toHaveBeenCalledWith({ pendingId: ROW.id, action: 'RESEND' });
  });

  it('cancels via the confirm dialog', () => {
    render(<PendingInvitePanel workspaceId="ws" />);
    fireEvent.click(screen.getByTestId('pending-invite-cancel'));
    fireEvent.click(screen.getByTestId('pending-invite-cancel-submit'));
    expect(cancelMut.mutateAsync).toHaveBeenCalledWith(ROW.id);
  });

  it('shows the empty state when there are no pending invites', () => {
    pendingData = { pending: [] };
    render(<PendingInvitePanel workspaceId="ws" />);
    expect(screen.getByTestId('pending-invite-empty')).toBeTruthy();
  });

  it('marks an expired invite', () => {
    pendingData = { pending: [{ ...ROW, expired: true }] };
    render(<PendingInvitePanel workspaceId="ws" />);
    expect(screen.getByTestId('pending-invite-status').textContent).toContain('만료됨');
  });
});
