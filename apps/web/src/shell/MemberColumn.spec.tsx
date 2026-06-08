// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ListMembersResponse, MemberWithPresence } from '@qufox/shared-types';

/**
 * S74 (D14 / FR-PS-06 + S73 carryover): 멤버 컬럼 표시 우선순위 테스트.
 *   - 표시명: ws nickname > 전역 displayName > username.
 *   - 아바타: ws avatarUrl > 전역 avatarUrl > 이니셜(Avatar 프리미티브).
 */
vi.mock('../design-system/primitives', () => ({
  Avatar: ({ name }: { name: string }) => <span data-testid="initials-avatar">{name}</span>,
  Icon: () => <svg aria-hidden="true" />,
}));
// S75 (FR-PS-07): 멤버 행이 프로필 팝오버로 감싸지지만, 이 스펙은 표시 우선순위만 검증하므로
// 팝오버(useQuery/Radix Portal)는 children passthrough 로 모킹한다(테스트 격리 + QueryClient 불요).
vi.mock('../features/profile/ProfilePopover', () => ({
  ProfilePopover: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let groupsData: ListMembersResponse | undefined;
vi.mock('../features/workspaces/useWorkspaces', () => ({
  useMemberGroups: () => ({ data: groupsData }),
}));
vi.mock('../features/realtime/useViewportPresence', () => ({
  useViewportPresence: () => ({ register: () => () => undefined }),
}));
vi.mock('../features/realtime/useUserPresence', () => ({
  useUserPresence: () => undefined,
}));
let memberListOpen = true;
vi.mock('../stores/ui-store', () => ({
  useUI: (sel: (s: { memberListOpen: boolean; activeChannelId: string | null }) => unknown) =>
    sel({ memberListOpen, activeChannelId: null }),
}));

import { MemberColumn } from './MemberColumn';

function member(over: Partial<MemberWithPresence['user']>): MemberWithPresence {
  return {
    userId: '00000000-0000-0000-0000-000000000001',
    workspaceId: '00000000-0000-0000-0000-000000000010',
    role: 'MEMBER',
    joinedAt: '2025-01-01T00:00:00.000Z',
    user: {
      id: '00000000-0000-0000-0000-000000000001',
      username: 'alice',
      email: 'a@b.com',
      ...over,
    },
    status: 'online',
    lastSeenAt: null,
  };
}

function setMembers(m: MemberWithPresence): void {
  groupsData = {
    hoist: [],
    groups: [{ key: 'online', label: '온라인', members: [m] }],
    nextCursor: null,
    includeOffline: true,
  };
}

beforeEach(() => {
  memberListOpen = true;
});
afterEach(() => cleanup());

describe('MemberColumn display priority (FR-PS-06)', () => {
  it('shows ws nickname over displayName over username', () => {
    setMembers(member({ displayName: 'Alice Disp', wsNickname: 'Ace' }));
    render(<MemberColumn workspaceId="w1" />);
    expect(screen.getByTestId('member-name-alice').textContent).toBe('Ace');
  });

  it('falls back to global displayName when no ws nickname', () => {
    setMembers(member({ displayName: 'Alice Disp', wsNickname: null }));
    render(<MemberColumn workspaceId="w1" />);
    expect(screen.getByTestId('member-name-alice').textContent).toBe('Alice Disp');
  });

  it('falls back to username when nothing else set', () => {
    setMembers(member({}));
    render(<MemberColumn workspaceId="w1" />);
    expect(screen.getByTestId('member-name-alice').textContent).toBe('alice');
  });

  it('renders the ws avatar image over the global avatar', () => {
    setMembers(member({ avatarUrl: 'http://g.png', wsAvatarUrl: 'http://ws.png' }));
    render(<MemberColumn workspaceId="w1" />);
    const img = screen.getByTestId('member-avatar-alice') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('http://ws.png');
  });

  it('falls back to initials Avatar when no avatar url', () => {
    setMembers(member({ displayName: 'Alice Disp' }));
    render(<MemberColumn workspaceId="w1" />);
    expect(screen.queryByTestId('member-avatar-alice')).toBeNull();
    expect(screen.getByTestId('initials-avatar').textContent).toBe('Alice Disp');
  });
});

/**
 * FR-P09 fix-forward (a11y BLOCKER · WCAG 1.4.3): hoist 그룹 헤더는 역할 colorHex 를
 * 헤더 텍스트 color 로 적용하지 않는다(사용자 지정 색이 12px/600 텍스트 4.5:1 대비를
 * 만족하지 못하므로). 색은 라벨 옆 aria-hidden 색 점으로만 표시하고 헤더 텍스트는 DS
 * 기본색(qf-memberlist__group)을 유지한다.
 */
describe('MemberColumn hoist group color a11y (FR-P09 · WCAG 1.4.3)', () => {
  function setHoist(color: string | null): void {
    groupsData = {
      hoist: [
        {
          key: '00000000-0000-0000-0000-0000000000aa',
          label: 'OWNER',
          color,
          members: [member({})],
        },
      ],
      groups: [],
      nextCursor: null,
      includeOffline: true,
    };
  }

  it('renders the role color as an aria-hidden dot, not as header text color', () => {
    setHoist('#5865F2');
    render(<MemberColumn workspaceId="w1" />);
    // 헤더 텍스트에는 인라인 color 가 없어야 한다(DS 기본색 유지).
    const header = screen.getByRole('heading', { level: 3 });
    expect(header.style.color).toBe('');
    // 색은 aria-hidden 점의 backgroundColor 로만 노출된다.
    const dot = screen.getByTestId('hoist-group-dot');
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(dot.style.backgroundColor).not.toBe('');
    // 역할명 텍스트는 항상 동반된다(1.4.1 색 단독 비의존).
    expect(header.textContent).toContain('OWNER');
  });

  it('omits the color dot when the role has no color', () => {
    setHoist(null);
    render(<MemberColumn workspaceId="w1" />);
    expect(screen.queryByTestId('hoist-group-dot')).toBeNull();
    expect(screen.getByRole('heading', { level: 3 }).style.color).toBe('');
  });
});
