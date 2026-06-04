// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { MemberDirectoryRow } from '@qufox/shared-types';

vi.mock('../../design-system/primitives', () => ({
  Icon: ({ name }: { name: string }) => <svg data-testid={`icon-${name}`} aria-hidden="true" />,
  Avatar: ({ name }: { name: string }) => <span aria-hidden="true">{name.slice(0, 2)}</span>,
}));

import { MemberProfilePanel } from './MemberProfilePanel';

function row(over: Partial<MemberDirectoryRow> = {}): MemberDirectoryRow {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-0000000000aa',
    role: 'MEMBER',
    joinedAt: '2025-01-01T00:00:00.000Z',
    user: { id: '00000000-0000-4000-8000-000000000001', username: 'bob', email: null },
    status: 'online',
    lastSeenAt: null,
    mutedUntil: null,
    invitedById: null,
    invitedBy: null,
    ...over,
  };
}

afterEach(() => cleanup());

describe('S69 MemberProfilePanel (a11y/security)', () => {
  it('username 은 h3 제목으로 렌더된다(M-04)', () => {
    render(<MemberProfilePanel member={row()} onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'bob', level: 3 })).toBeTruthy();
  });

  it('역할은 한글 라벨로 표시된다', () => {
    render(<MemberProfilePanel member={row({ role: 'ADMIN' })} onClose={() => {}} />);
    expect(screen.getByText('관리자')).toBeTruthy();
  });

  it('email 이 null(비관리자 뷰어)이면 이메일을 렌더하지 않는다(security)', () => {
    render(<MemberProfilePanel member={row()} onClose={() => {}} />);
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it('email 이 있으면(ADMIN+ 뷰어) 이메일을 렌더한다', () => {
    render(
      <MemberProfilePanel
        member={row({ user: { id: 'u', username: 'bob', email: 'bob@example.com' } })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('bob@example.com')).toBeTruthy();
  });

  it('landmark 과잉 제거 — section/header 대신 div 다(H-05/N-02)', () => {
    const { container } = render(<MemberProfilePanel member={row()} onClose={() => {}} />);
    expect(container.querySelector('section')).toBeNull();
    expect(container.querySelector('header')).toBeNull();
  });
});
