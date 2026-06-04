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

// S75 (FR-PS-08): 전체 프로필 패널 상호배타.
describe('ui-store profilePanelUserId (FR-PS-08)', () => {
  beforeEach(() => {
    useUI.setState({
      profilePanelUserId: null,
      memberDirectoryOpen: false,
      searchPanelQuery: null,
      activityInboxOpen: false,
    });
  });

  it('setProfilePanelUser(userId) 가 다른 우측 패널을 닫는다', () => {
    useUI.setState({
      memberDirectoryOpen: true,
      searchPanelQuery: 'q',
      activityInboxOpen: true,
    });
    useUI.getState().setProfilePanelUser('u1');
    const s = useUI.getState();
    expect(s.profilePanelUserId).toBe('u1');
    expect(s.memberDirectoryOpen).toBe(false);
    expect(s.searchPanelQuery).toBeNull();
    expect(s.activityInboxOpen).toBe(false);
  });

  it('setProfilePanelUser(null) 이 패널만 닫고 다른 상태는 보존한다', () => {
    useUI.setState({ profilePanelUserId: 'u1', searchPanelQuery: 'keep' });
    useUI.getState().setProfilePanelUser(null);
    const s = useUI.getState();
    expect(s.profilePanelUserId).toBeNull();
    expect(s.searchPanelQuery).toBe('keep');
  });

  // S75 fix-forward (F14): 우측 슬롯 상호배타를 대칭으로 — 검색/inbox/디렉터리를
  // "여는" 분기가 열린 프로필 패널을 닫아야 한다.
  it('F14: openSearchPanel 이 열린 프로필 패널을 닫는다', () => {
    useUI.setState({ profilePanelUserId: 'u1' });
    useUI.getState().openSearchPanel('hi');
    expect(useUI.getState().profilePanelUserId).toBeNull();
    expect(useUI.getState().searchPanelQuery).toBe('hi');
  });

  it('F14: setActivityInboxOpen(true) / toggleActivityInbox 가 프로필 패널을 닫는다', () => {
    useUI.setState({ profilePanelUserId: 'u1' });
    useUI.getState().setActivityInboxOpen(true);
    expect(useUI.getState().profilePanelUserId).toBeNull();
    expect(useUI.getState().activityInboxOpen).toBe(true);

    useUI.setState({ profilePanelUserId: 'u2', activityInboxOpen: false });
    useUI.getState().toggleActivityInbox();
    expect(useUI.getState().profilePanelUserId).toBeNull();
    expect(useUI.getState().activityInboxOpen).toBe(true);
  });

  it('F14: setMemberDirectoryOpen(true) / toggleMemberDirectory 가 프로필 패널을 닫는다', () => {
    useUI.setState({ profilePanelUserId: 'u1' });
    useUI.getState().setMemberDirectoryOpen(true);
    expect(useUI.getState().profilePanelUserId).toBeNull();

    useUI.setState({ profilePanelUserId: 'u2', memberDirectoryOpen: false });
    useUI.getState().toggleMemberDirectory();
    expect(useUI.getState().profilePanelUserId).toBeNull();
  });
});
