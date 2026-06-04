// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

/**
 * S72 (D13 / FR-W16): /discover 카드 CTA 의 joinMode 3분기.
 *   PUBLIC  → "참가"      → join 뮤테이션 → 가입 후 워크스페이스로 이동.
 *   APPLY   → "신청"      → /w/:slug/apply 신청 폼으로 이동(join 미호출).
 *   PRIVATE → "초대 필요"  → 비활성 레이블(클릭 불가).
 *
 * useDiscovery 훅과 react-router 의 useNavigate 를 vi.fn() 으로 모킹한다.
 */

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

const mutateAsync = vi.fn();
const useDiscoverWorkspaces = vi.fn();
vi.mock('./useDiscovery', () => ({
  useDiscoverWorkspaces: (...args: unknown[]) => useDiscoverWorkspaces(...args),
  useJoinWorkspace: () => ({ mutateAsync }),
}));

import { DiscoverPage } from './DiscoverPage';

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

describe('DiscoverPage — joinMode CTA (FR-W16)', () => {
  it('renders 참가 / 신청 / 초대 필요 by joinMode', () => {
    render(<DiscoverPage />);
    expect(screen.getByTestId('discover-cta-pub').textContent).toContain('참가');
    expect(screen.getByTestId('discover-cta-apply').textContent).toContain('신청');
    expect(screen.getByTestId('discover-cta-priv').textContent).toContain('초대 필요');
  });

  it('PUBLIC card joins then routes into the workspace', async () => {
    render(<DiscoverPage />);
    fireEvent.click(screen.getByTestId('discover-cta-pub'));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ workspaceId: 'id-pub' }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/w/pub'));
  });

  it('APPLY card routes to the application form without joining', () => {
    render(<DiscoverPage />);
    fireEvent.click(screen.getByTestId('discover-cta-apply'));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/w/apply/apply');
  });

  it('PRIVATE card CTA is disabled and does nothing on click', () => {
    render(<DiscoverPage />);
    const cta = screen.getByTestId('discover-cta-priv') as HTMLButtonElement;
    expect(cta.getAttribute('aria-disabled') === 'true' || cta.disabled).toBe(true);
    fireEvent.click(cta);
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
