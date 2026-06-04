// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

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
  Input: ({ onChange, onKeyDown, value, ...rest }: Record<string, unknown>) => (
    <input
      value={value as string}
      onChange={onChange as () => void}
      onKeyDown={onKeyDown as () => void}
      {...rest}
    />
  ),
}));

const updateMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
vi.mock('./useWorkspaces', () => ({
  useUpdateWorkspace: () => updateMut,
}));

import { EmailDomainsPanel } from './EmailDomainsPanel';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  updateMut.mutateAsync.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('S68 EmailDomainsPanel (FR-W05)', () => {
  it('non-OWNER sees the read-only note and no add controls', () => {
    render(<EmailDomainsPanel workspaceId="ws" initialDomains={['acme.com']} canEdit={false} />);
    expect(screen.getByTestId('email-domains-owner-note')).toBeTruthy();
    expect(screen.queryByTestId('email-domain-add')).toBeNull();
  });

  it('OWNER can add a domain and save the full list via PATCH', () => {
    render(<EmailDomainsPanel workspaceId="ws" initialDomains={['acme.com']} canEdit />);
    fireEvent.change(screen.getByTestId('email-domain-input'), { target: { value: 'beta.io' } });
    fireEvent.click(screen.getByTestId('email-domain-add'));
    fireEvent.click(screen.getByTestId('email-domains-save'));
    expect(updateMut.mutateAsync).toHaveBeenCalledWith({
      emailDomains: ['acme.com', 'beta.io'],
    });
  });

  it('rejects a malformed domain with a validation message', () => {
    render(<EmailDomainsPanel workspaceId="ws" initialDomains={[]} canEdit />);
    fireEvent.change(screen.getByTestId('email-domain-input'), {
      target: { value: 'not a domain' },
    });
    fireEvent.click(screen.getByTestId('email-domain-add'));
    expect(screen.getByTestId('email-domains-error')).toBeTruthy();
  });

  it('shows the broad-domain warning for a TLD-level / 2-level public suffix (S66 MEDIUM-2)', () => {
    render(<EmailDomainsPanel workspaceId="ws" initialDomains={['co.uk']} canEdit />);
    expect(screen.getByTestId('email-domains-broad-warning')).toBeTruthy();
  });

  it('does not warn for a normal company host', () => {
    render(<EmailDomainsPanel workspaceId="ws" initialDomains={['mail.acme.com']} canEdit />);
    expect(screen.queryByTestId('email-domains-broad-warning')).toBeNull();
  });

  it('OWNER can remove a domain', () => {
    render(<EmailDomainsPanel workspaceId="ws" initialDomains={['acme.com', 'beta.io']} canEdit />);
    const removes = screen.getAllByTestId('email-domain-remove');
    fireEvent.click(removes[0]);
    fireEvent.click(screen.getByTestId('email-domains-save'));
    expect(updateMut.mutateAsync).toHaveBeenCalledWith({ emailDomains: ['beta.io'] });
  });
});
