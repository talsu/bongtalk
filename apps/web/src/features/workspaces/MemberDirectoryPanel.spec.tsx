// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { MemberDirectoryRow } from '@qufox/shared-types';

// S69 fix-forward (a11y): 디렉터리 패널의 aria/empty/role-label/aria-busy 회귀 가드.

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
  Icon: ({ name, ...rest }: { name: string; [k: string]: unknown }) => (
    <svg data-testid={`icon-${name}`} aria-hidden="true" {...rest} />
  ),
  Avatar: ({ name }: { name: string }) => <span aria-hidden="true">{name.slice(0, 2)}</span>,
  Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
}));

vi.mock('../../stores/notification-store', () => ({
  useNotifications: () => vi.fn(),
}));

type DirectoryQuery = {
  data: { pages: Array<{ members: MemberDirectoryRow[]; nextCursor: string | null }> } | undefined;
  isLoading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
};

let directoryQuery: DirectoryQuery;

vi.mock('./useWorkspaces', () => ({
  useMembersDirectory: () => directoryQuery,
  useBulkMemberAction: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { MemberDirectoryPanel } from './MemberDirectoryPanel';

function row(over: Partial<MemberDirectoryRow> = {}): MemberDirectoryRow {
  return {
    userId: over.userId ?? '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-0000000000aa',
    role: over.role ?? 'MEMBER',
    joinedAt: '2025-01-01T00:00:00.000Z',
    user: {
      id: over.userId ?? '00000000-0000-4000-8000-000000000001',
      username: 'alice',
      email: null,
    },
    status: over.status ?? 'online',
    lastSeenAt: null,
    mutedUntil: over.mutedUntil ?? null,
    invitedById: null,
    invitedBy: null,
    ...over,
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  directoryQuery = {
    data: { pages: [{ members: [row()], nextCursor: null }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
});
afterEach(() => cleanup());

describe('S69 MemberDirectoryPanel (a11y)', () => {
  it('패널에 sr-only h2 제목이 있다', () => {
    render(<MemberDirectoryPanel workspaceId="ws" currentUserId="me" canManage={false} />);
    expect(screen.getByRole('heading', { name: '멤버 디렉터리', level: 2 })).toBeTruthy();
  });

  it('멤버 행 버튼의 접근가능 이름에 username + 상태 라벨이 포함된다(H-02)', () => {
    directoryQuery.data = { pages: [{ members: [row({ status: 'idle' })], nextCursor: null }] };
    render(<MemberDirectoryPanel workspaceId="ws" currentUserId="me" canManage={false} />);
    expect(screen.getByRole('button', { name: 'alice, 자리 비움' })).toBeTruthy();
  });

  it('역할은 한글 라벨로 표시된다(N-01)', () => {
    directoryQuery.data = { pages: [{ members: [row({ role: 'MODERATOR' })], nextCursor: null }] };
    render(<MemberDirectoryPanel workspaceId="ws" currentUserId="me" canManage={false} />);
    // 역할 필터 드롭다운에도 '모더레이터' 옵션이 있으므로 목록 안으로 스코프한다.
    const list = screen.getByTestId('member-directory-list');
    expect(within(list).getByText('모더레이터')).toBeTruthy();
  });

  it('타임아웃 행에 sr-only "타임아웃 중" 텍스트가 있다(H-03)', () => {
    directoryQuery.data = {
      pages: [{ members: [row({ mutedUntil: '2025-12-31T00:00:00.000Z' })], nextCursor: null }],
    };
    render(<MemberDirectoryPanel workspaceId="ws" currentUserId="me" canManage={false} />);
    expect(screen.getByText('타임아웃 중')).toBeTruthy();
  });

  it('빈 상태에서 안내 행을 보여준다(M-03)', () => {
    directoryQuery.data = { pages: [{ members: [], nextCursor: null }] };
    render(<MemberDirectoryPanel workspaceId="ws" currentUserId="me" canManage={false} />);
    expect(screen.getByText('일치하는 멤버가 없습니다.')).toBeTruthy();
  });

  it('로딩 중 목록은 aria-busy=true 다(M-02)', () => {
    directoryQuery.isLoading = true;
    directoryQuery.data = undefined;
    render(<MemberDirectoryPanel workspaceId="ws" currentUserId="me" canManage={false} />);
    const list = screen.getByTestId('member-directory-list');
    expect(list.getAttribute('aria-busy')).toBe('true');
  });

  it('canManage 가 false 면 선택 체크박스를 노출하지 않는다', () => {
    render(<MemberDirectoryPanel workspaceId="ws" currentUserId="me" canManage={false} />);
    const list = screen.getByTestId('member-directory-list');
    expect(within(list).queryByRole('checkbox')).toBeNull();
  });
});
