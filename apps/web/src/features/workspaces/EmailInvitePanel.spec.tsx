// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { InviteByEmailResponse } from '@qufox/shared-types';

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

const inviteMut = {
  mutateAsync:
    vi.fn<(args: { emails: string[]; role: string }) => Promise<InviteByEmailResponse>>(),
  isPending: false,
};

vi.mock('./useEmailInvites', () => ({
  useInviteByEmail: () => inviteMut,
}));

import { EmailInvitePanel } from './EmailInvitePanel';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  inviteMut.mutateAsync.mockReset();
  inviteMut.isPending = false;
});
afterEach(() => cleanup());

describe('S68 EmailInvitePanel', () => {
  it('counts parsed emails (comma/newline/space split + dedupe)', () => {
    render(<EmailInvitePanel workspaceId="ws" />);
    const input = screen.getByTestId('email-invite-input');
    fireEvent.change(input, { target: { value: 'a@x.com, a@x.com\nb@x.com c@x.com' } });
    // 3 unique → label shows 3/50.
    expect(screen.getByText('(3/50)')).toBeTruthy();
  });

  it('warns and disables submit when over 50 emails', () => {
    render(<EmailInvitePanel workspaceId="ws" />);
    const emails = Array.from({ length: 51 }, (_, i) => `u${i}@x.com`).join(', ');
    fireEvent.change(screen.getByTestId('email-invite-input'), { target: { value: emails } });
    expect(screen.getByTestId('email-invite-too-many')).toBeTruthy();
    expect((screen.getByTestId('email-invite-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits parsed emails + role and renders partial-success results', async () => {
    inviteMut.mutateAsync.mockResolvedValue({
      results: [
        { email: 'member@x.com', outcome: 'ADDED_MEMBER' },
        { email: 'new@x.com', outcome: 'PENDING' },
        { email: 'bad@x.com', outcome: 'FAILED', error: 'bounced' },
      ],
      sentCount: 1,
      addedCount: 1,
      failedCount: 1,
    });
    render(<EmailInvitePanel workspaceId="ws" />);
    fireEvent.change(screen.getByTestId('email-invite-input'), {
      target: { value: 'member@x.com, new@x.com, bad@x.com' },
    });
    fireEvent.change(screen.getByTestId('email-invite-role'), { target: { value: 'GUEST' } });
    fireEvent.click(screen.getByTestId('email-invite-submit'));
    // flush the mutateAsync microtask.
    await screen.findByTestId('email-invite-results');
    expect(inviteMut.mutateAsync).toHaveBeenCalledWith({
      emails: ['member@x.com', 'new@x.com', 'bad@x.com'],
      role: 'GUEST',
    });
    const rows = within(screen.getByTestId('email-invite-results')).getAllByTestId(
      'email-invite-result-row',
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.getAttribute('data-outcome') === 'FAILED')).toBeTruthy();
  });
});
