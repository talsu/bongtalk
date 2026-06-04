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
  // S68 fix-forward: 패널이 ⚠ Icon(aria-hidden)을 쓰므로 mock 에 추가한다.
  Icon: ({ name }: { name: string }) => <svg data-testid={`icon-${name}`} aria-hidden="true" />,
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
    const resultsRegion = screen.getByTestId('email-invite-results');
    const rows = within(resultsRegion).getAllByTestId('email-invite-result-row');
    expect(rows).toHaveLength(3);
    const failedRow = rows.find((r) => r.getAttribute('data-outcome') === 'FAILED');
    expect(failedRow).toBeTruthy();
    // S68 a11y (HIGH-2): 결과 컨테이너는 status 라이브 영역 + 요약(완료/실패)을 노출한다.
    expect(resultsRegion.getAttribute('role')).toBe('status');
    expect(resultsRegion.getAttribute('aria-atomic')).toBe('true');
    expect(within(resultsRegion).getByText(/3건 처리: 2건 완료, 1건 실패\./)).toBeTruthy();
    // S68 a11y (HIGH-1): 실패 상세(error)가 sr-only 로도 노출된다.
    expect(within(failedRow!).getByText(/: bounced/)).toBeTruthy();
  });
});
