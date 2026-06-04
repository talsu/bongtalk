// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

/**
 * S72 W16 fix-forward (contract/ui-designer): 모바일 /discover 행 탭의 joinMode 3분기를
 * 데스크톱 JoinCta 와 일치시킨다.
 *   PUBLIC  → 탭 시 join 뮤테이션 → 가입 후 워크스페이스로 이동.
 *   APPLY   → 탭 시 /w/:slug/apply 신청 폼으로 이동(join 미호출).
 *   PRIVATE → 비활성(aria-disabled) → 탭해도 아무 동작 없음.
 *
 * useDiscovery 훅과 react-router 의 useNavigate 를 vi.fn() 으로 모킹한다.
 */

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

const mutateAsync = vi.fn();
const useDiscoverWorkspaces = vi.fn();
vi.mock('../../features/discovery/useDiscovery', () => ({
  useDiscoverWorkspaces: (...args: unknown[]) => useDiscoverWorkspaces(...args),
  useJoinWorkspace: () => ({ mutateAsync }),
}));

// MobileTabBar pulls in nothing heavy, but stub to keep the render minimal.
vi.mock('./MobileTabBar', () => ({
  MobileTabBar: () => null,
}));

import { MobileDiscover } from './MobileDiscover';

function makeItem(over: { slug: string; joinMode: string } & Record<string, unknown>) {
  return {
    id: `id-${over.slug}`,
    name: `WS ${over.slug}`,
    description: 'desc',
    iconUrl: null,
    category: 'PROGRAMMING',
    memberCount: 3,
    lastActivityAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  navigate.mockReset();
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ workspaceId: 'id-pub', alreadyMember: false });
  useDiscoverWorkspaces.mockReset();
  useDiscoverWorkspaces.mockReturnValue({
    data: {
      items: [
        makeItem({ slug: 'pub', joinMode: 'PUBLIC' }),
        makeItem({ slug: 'apply', joinMode: 'APPLY' }),
        makeItem({ slug: 'priv', joinMode: 'PRIVATE' }),
      ],
      nextCursor: null,
    },
    isLoading: false,
  });
});

afterEach(() => {
  cleanup();
});

describe('MobileDiscover — joinMode 3-branch (FR-W16)', () => {
  it('renders 참가(+icon) / 신청 / 초대 필요 asides by joinMode', () => {
    render(<MobileDiscover />);
    expect(screen.getByTestId('mobile-discover-cta-apply').textContent).toContain('신청');
    expect(screen.getByTestId('mobile-discover-cta-priv').textContent).toContain('초대 필요');
  });

  it('PUBLIC row joins then routes into the workspace', async () => {
    render(<MobileDiscover />);
    fireEvent.click(screen.getByTestId('mobile-discover-row-pub'));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ workspaceId: 'id-pub' }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/w/pub'));
  });

  it('APPLY row routes to the application form without joining', () => {
    render(<MobileDiscover />);
    fireEvent.click(screen.getByTestId('mobile-discover-row-apply'));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/w/apply/apply');
  });

  it('PRIVATE row is aria-disabled and does nothing on tap', () => {
    render(<MobileDiscover />);
    const row = screen.getByTestId('mobile-discover-row-priv');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(row);
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
