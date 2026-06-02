// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useUI } from '../../stores/ui-store';
import { ActivityBellButton } from '../../shell/MessageColumn';
import { ActivityInboxPanel } from './ActivityInboxPanel';

/**
 * S47 fix-forward (BLOCKER-1 · FR-MN-13): 토픽바 알림 벨이 Activity Inbox 패널을
 * 실제로 토글하는지(死코드 제거) 통합 검증한다. 종전엔 ui-store 의 toggleActivityInbox
 * 가 어디서도 호출되지 않아 <ActivityInboxPanel/> 이 영영 마운트되지 않았다.
 *
 * 실제 useUI(zustand) 스토어를 그대로 쓰고, Shell 의 우측 슬롯 조건(activityInboxOpen)
 * 을 본 트리에서 재현해, 벨 클릭 → store 토글 → 패널 마운트 → 재클릭 → 언마운트를
 * 단언한다. 데이터 hook 만 모킹(네트워크 없음).
 */
vi.mock('./useActivity', () => ({
  useActivityInbox: () => ({
    data: { pages: [{ items: [], nextCursor: null }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useActivityUnread: () => ({
    data: { total: 0, mentions: 0, replies: 0, reactions: 0, directs: 0, friendRequests: 0 },
  }),
  useMarkActivityRead: () => ({ mutate: vi.fn() }),
  useMarkAllActivityRead: () => ({ mutate: vi.fn() }),
}));

vi.mock('../workspaces/useWorkspaces', () => ({
  useMyWorkspaces: () => ({ data: { workspaces: [] } }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('../../stores/notification-store', () => ({
  useNotifications: (selector: (s: { push: () => void }) => unknown) => selector({ push: vi.fn() }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: () => undefined }),
}));

vi.mock('../../design-system/primitives', () => ({
  Icon: () => null,
  Avatar: () => null,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function Harness(): JSX.Element {
  const open = useUI((s) => s.activityInboxOpen);
  return (
    <div>
      <ActivityBellButton />
      {open ? <ActivityInboxPanel /> : null}
    </div>
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  useUI.getState().setActivityInboxOpen(false);
});

afterEach(() => {
  cleanup();
  useUI.getState().setActivityInboxOpen(false);
});

describe('Activity bell ↔ inbox panel wiring (S47 · BLOCKER-1)', () => {
  it('초기에는 패널이 마운트되지 않고, 벨은 aria-expanded=false', () => {
    render(<Harness />);
    expect(screen.queryByTestId('activity-inbox-panel')).toBeNull();
    expect(screen.getByTestId('topbar-activity-bell').getAttribute('aria-expanded')).toBe('false');
  });

  it('벨 클릭 → 패널 마운트 + aria-expanded=true, 재클릭 → 언마운트', () => {
    render(<Harness />);
    const bell = screen.getByTestId('topbar-activity-bell');

    act(() => {
      fireEvent.click(bell);
    });
    expect(screen.getByTestId('activity-inbox-panel')).toBeTruthy();
    expect(screen.getByTestId('topbar-activity-bell').getAttribute('aria-expanded')).toBe('true');
    expect(useUI.getState().activityInboxOpen).toBe(true);

    act(() => {
      fireEvent.click(screen.getByTestId('topbar-activity-bell'));
    });
    expect(screen.queryByTestId('activity-inbox-panel')).toBeNull();
    expect(useUI.getState().activityInboxOpen).toBe(false);
  });

  it('벨 aria-controls 가 패널 id(activity-inbox-panel)를 가리킨다', () => {
    render(<Harness />);
    const bell = screen.getByTestId('topbar-activity-bell');
    expect(bell.getAttribute('aria-controls')).toBe('activity-inbox-panel');
    act(() => {
      fireEvent.click(bell);
    });
    expect(screen.getByTestId('activity-inbox-panel').getAttribute('id')).toBe(
      'activity-inbox-panel',
    );
  });
});
