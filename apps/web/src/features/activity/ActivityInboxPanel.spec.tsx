// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

/**
 * S47 (FR-MN-13): Activity Inbox 패널 — role/탭 ARIA, 탭별 empty 카피, skeleton
 * 200ms 지연, 탭 리매핑을 jsdom 으로 검증한다. 데이터 hook 을 모킹해 네트워크 없이
 * 렌더한다. S47 fix-forward: aside 한국어 라벨·roving tablist·qf-skel·tabpanel
 * aria-busy/tabIndex 를 함께 검증한다.
 */

// 모킹 가능한 가변 상태(테스트마다 교체).
let inboxState: {
  data: { pages: Array<{ items: unknown[]; nextCursor: string | null }> } | undefined;
  isLoading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
};

const markReadMutate = vi.fn();
const markAllMutate = vi.fn();

vi.mock('./useActivity', () => ({
  useActivityInbox: () => inboxState,
  useActivityUnread: () => ({
    data: { total: 0, mentions: 0, replies: 0, reactions: 0, directs: 0, friendRequests: 0 },
  }),
  useMarkActivityRead: () => ({ mutate: markReadMutate }),
  useMarkAllActivityRead: () => ({ mutate: markAllMutate }),
}));

vi.mock('../workspaces/useWorkspaces', () => ({
  useMyWorkspaces: () => ({ data: { workspaces: [] } }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

const pushToast = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (selector: (s: { push: typeof pushToast }) => unknown) =>
    selector({ push: pushToast }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: () => undefined }),
}));

// DS primitives 는 단순 렌더 스텁(아이콘/아바타는 마크업만).
vi.mock('../../design-system/primitives', () => ({
  Icon: () => null,
  Avatar: () => null,
}));

import { ActivityInboxPanel } from './ActivityInboxPanel';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  inboxState = {
    data: { pages: [{ items: [], nextCursor: null }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
  markReadMutate.mockClear();
  markAllMutate.mockClear();
  pushToast.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ActivityInboxPanel (S47 · FR-MN-13)', () => {
  it('패널 루트 role="complementary"(한국어 라벨) + 탭 tablist/tab/tabpanel 패턴', () => {
    render(<ActivityInboxPanel />);
    expect(screen.getByRole('complementary', { name: '알림 인박스' })).toBeTruthy();
    expect(screen.getByRole('tablist')).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(screen.getByRole('tabpanel')).toBeTruthy();
    // 기본 선택 탭은 All.
    expect(screen.getByTestId('activity-inbox-tab-all').getAttribute('aria-selected')).toBe('true');
  });

  it('A-1 roving tabIndex: 활성 탭만 tabIndex=0, 나머지 -1', () => {
    render(<ActivityInboxPanel />);
    expect(screen.getByTestId('activity-inbox-tab-all').getAttribute('tabindex')).toBe('0');
    expect(screen.getByTestId('activity-inbox-tab-mentions').getAttribute('tabindex')).toBe('-1');
  });

  it('A-1 ArrowRight 로 다음 탭으로 이동 + 선택 전환', () => {
    render(<ActivityInboxPanel />);
    const allTab = screen.getByTestId('activity-inbox-tab-all');
    act(() => {
      fireEvent.keyDown(allTab, { key: 'ArrowRight' });
    });
    expect(screen.getByTestId('activity-inbox-tab-mentions').getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('A-3/B-2 tabpanel: aria-busy 미로딩 시 false + tabIndex=0', () => {
    render(<ActivityInboxPanel />);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-busy')).toBe('false');
    expect(panel.getAttribute('tabindex')).toBe('0');
  });

  it('비어있을 때 기본(All) 탭 empty 카피를 렌더한다', () => {
    render(<ActivityInboxPanel />);
    expect(screen.getByTestId('activity-inbox-empty').textContent).toContain(
      '아직 알림이 없습니다',
    );
  });

  it('탭 전환 시 해당 탭의 empty 카피로 바뀐다(threads → 스레드 댓글 알림이 없습니다)', () => {
    render(<ActivityInboxPanel />);
    act(() => {
      fireEvent.click(screen.getByTestId('activity-inbox-tab-threads'));
    });
    expect(screen.getByTestId('activity-inbox-empty').textContent).toContain(
      '스레드 댓글 알림이 없습니다',
    );
    act(() => {
      fireEvent.click(screen.getByTestId('activity-inbox-tab-dms'));
    });
    expect(screen.getByTestId('activity-inbox-empty').textContent).toContain('DM 알림이 없습니다');
  });

  it('로딩 200ms 이상 지연 시 .qf-skel 3행 + aria-busy/status 를 렌더한다(그 전엔 미표시)', () => {
    inboxState = {
      data: undefined,
      isLoading: true,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    };
    render(<ActivityInboxPanel />);
    // A-3: 로딩 중 tabpanel aria-busy=true.
    expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('true');
    // 200ms 전에는 skeleton 미표시.
    expect(screen.queryByTestId('activity-inbox-skeleton')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const skeleton = screen.getByTestId('activity-inbox-skeleton');
    expect(skeleton).toBeTruthy();
    // BLOCKER-8: DS 실재 클래스 qf-skel(오타 qf-skeleton 아님) 3행.
    expect(skeleton.querySelectorAll('.qf-skel')).toHaveLength(3);
    expect(skeleton.querySelectorAll('.qf-skeleton')).toHaveLength(0);
    // A-3: role=status aria-live.
    expect(skeleton.getAttribute('role')).toBe('status');
    expect(skeleton.getAttribute('aria-live')).toBe('polite');
  });
});
