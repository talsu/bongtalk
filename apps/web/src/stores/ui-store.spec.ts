import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUI } from './ui-store';

// S69 fix-forward (a11y H-01): 디렉터리 오픈 시 검색/inbox 패널을 상호배타로 닫는다.

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  // 알려진 초기 상태로 리셋.
  useUI.setState({
    memberDirectoryOpen: false,
    searchPanelQuery: null,
    activityInboxOpen: false,
  });
});

describe('ui-store memberDirectory mutual exclusion', () => {
  it('toggleMemberDirectory 오픈 시 검색/inbox 패널을 닫는다', () => {
    useUI.setState({ searchPanelQuery: 'hello', activityInboxOpen: true });
    useUI.getState().toggleMemberDirectory();
    const s = useUI.getState();
    expect(s.memberDirectoryOpen).toBe(true);
    expect(s.searchPanelQuery).toBeNull();
    expect(s.activityInboxOpen).toBe(false);
  });

  it('toggleMemberDirectory 닫을 때는 다른 패널 상태를 건드리지 않는다', () => {
    useUI.setState({
      memberDirectoryOpen: true,
      searchPanelQuery: 'keep',
      activityInboxOpen: true,
    });
    useUI.getState().toggleMemberDirectory();
    const s = useUI.getState();
    expect(s.memberDirectoryOpen).toBe(false);
    expect(s.searchPanelQuery).toBe('keep');
    expect(s.activityInboxOpen).toBe(true);
  });

  it('setMemberDirectoryOpen(true) 도 검색/inbox 를 닫는다', () => {
    useUI.setState({ searchPanelQuery: 'x', activityInboxOpen: true });
    useUI.getState().setMemberDirectoryOpen(true);
    const s = useUI.getState();
    expect(s.memberDirectoryOpen).toBe(true);
    expect(s.searchPanelQuery).toBeNull();
    expect(s.activityInboxOpen).toBe(false);
  });
});
